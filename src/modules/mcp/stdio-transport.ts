// stdio-транспорт MCP: spawn, JSON-RPC handshake и построчный разбор ответов.
// Вынесено из `client.ts` (правило ≤300): клиент — диспетчер, транспорт — протокол.
import type { ChildProcess } from "child_process";
import type { MCPServerConfig } from "./registry";
import { spawnMcpServer, stopMcpServer } from "./stdio-spawn";

/** stdio-транспорт одного MCP-сервера: процесс, handshake, запросы, остановка. */
export class StdioTransport {
  private process: ChildProcess | null = null;
  private connected = false;
  /** Неразобранный хвост stdio-ответов (частичная строка). */
  private buffer = "";
  /** Монотонный id stdio-запросов (Date.now() коллизил на вызовах в одну мс). */
  private requestSeq = 0;

  constructor(private readonly config: MCPServerConfig) {}

  /** Есть ли живое соединение. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Подключиться: spawn + `initialize` handshake. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Windows: `npx` → `npx.cmd`; резолв шима и shell — в spawnMcpServer.
      const child = spawnMcpServer(this.config);

      let settled = false;
      child.on("error", (err) => {
        this.connected = false;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.on("exit", (code) => {
        this.connected = false;
        if (code !== 0 && !settled) {
          settled = true;
          reject(new Error(`MCP server exited with code ${code}`));
        }
      });

      child.on("spawn", () => {
        this.connected = true;
        this.process = child;
        // MCP-handshake: настоящие серверы требуют `initialize` перед
        // tools/list и tools/call.
        this.request(
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "mma", version: "1.0.0" },
          },
          10000,
        )
          .then(() => {
            child.stdin?.write(
              `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
            );
          })
          .then(() => {
            settled = true;
            resolve();
          })
          .catch((err) => {
            this.connected = false;
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
      });
    });
  }

  /**
   * JSON-RPC запрос поверх stdio: таймаут, обработка exit и построчный парсинг
   * с учётом буфера (нотификации и чужие ответы между запросом и ответом
   * матчинг больше не ломают).
   */
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const proc = this.process;
    if (!proc?.stdout || !proc.stdin) {
      return Promise.reject(new Error("Not connected to MCP server"));
    }
    const stdout = proc.stdout;
    const timeout = timeoutMs ?? this.config.timeout ?? 30000;

    return new Promise<T>((resolve, reject) => {
      const request = {
        jsonrpc: "2.0",
        id: ++this.requestSeq,
        method,
        ...(params !== undefined ? { params } : {}),
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        stdout.off("data", onData);
        proc.off("exit", onExit);
        fn();
      };
      const onData = (data: Buffer) => {
        this.buffer += data.toString();
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) !== -1 && !settled) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          let msg: {
            id?: number;
            error?: { message: string };
            result?: T;
          };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== request.id) continue; // нотификация или чужой ответ
          finish(() => {
            if (msg.error) {
              reject(new Error(msg.error!.message));
            } else {
              resolve(msg.result as T);
            }
          });
          return;
        }
      };
      const onExit = () => {
        finish(() => reject(new Error(`MCP server exited before responding to ${method}`)));
      };

      stdout.on("data", onData);
      proc.once("exit", onExit);
      timer = setTimeout(() => {
        finish(() => reject(new Error(`MCP ${method} timeout`)));
      }, timeout);

      proc.stdin!.write(`${JSON.stringify(request)}\n`);
    });
  }

  /** Остановить процесс и сбросить состояние. */
  disconnect(): void {
    if (this.process) {
      // cmd.exe → npx → node: kill() бьёт оболочку, killTree добивает дерево.
      stopMcpServer(this.process);
      this.process = null;
    }
    this.connected = false;
  }
}
