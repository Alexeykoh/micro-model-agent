// SSE-транспорт MCP: подключение к потоку, разбор событий и POST-запросы.
// Вынесено из `client.ts` (правило ≤300): клиент — диспетчер, транспорт — протокол.
import type { MCPServerConfig } from "./registry";
import { defaultOutputBus } from "../../output";
import { MCP_HTTP_TIMEOUT_MS as HTTP_TIMEOUT_MS } from "../../config/timeouts";
import { MCP_ACCEPT_HEADER, type MCPToolInfo } from "./protocol";

/** SSE-транспорт одного MCP-сервера: подписка на поток и ответы по id. */
export class SseTransport {
  private connected = false;
  private abortController: AbortController | null = null;
  /** In-flight SSE-вызовы по JSON-RPC id (один слот мешал конкурентные
   *  вызовы и матчил ответы по любому id — теперь слот на вызов). */
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private seq = 0;

  constructor(private readonly config: MCPServerConfig) {}

  /** Есть ли живое соединение. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Подключиться к SSE-потоку и читать его в фоне. */
  async connect(): Promise<void> {
    const url = this.config.url;
    if (!url) throw new Error("SSE transport requires a url");

    this.abortController = new AbortController();
    const timeout = setTimeout(
      () => this.abortController?.abort(),
      this.config.timeout || HTTP_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...this.config.headers,
        },
        signal: this.abortController.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      this.connected = true;

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const buffer = "";

      this.readSSE(reader, decoder, buffer);
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  private async readSSE(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    buffer: string,
  ): Promise<void> {
    try {
      while (this.connected) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        let data = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            data = line.slice(6);
          } else if (line === "") {
            if (eventType === "message" && data) {
              this.handleMessage(data);
            }
            eventType = "";
            data = "";
          }
        }
      }
    } catch (err: unknown) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleError(error);
      }
    }
    this.connected = false;
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) pending.reject(new Error(msg.error.message));
          else pending.resolve(msg.result);
        }
      }
    } catch (e) {
      // Хартбиты/комменты — не JSON: ожидаемый шум, но логируем, чтобы
      // реально битый стрим был виден в диагностике.
      defaultOutputBus.log(
        "error",
        "module:mcp",
        `[MCPClient] Unparseable SSE message: ${String(data).slice(0, 120)} ${e instanceof Error ? e.message : String(e)}`,
        { persist: true },
      );
    }
  }

  private handleError(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /** Отключиться: abort потока и сброс состояния. */
  disconnect(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.connected = false;
  }

  /** Список тулов через POST в SSE-сессию. */
  async listTools(): Promise<MCPToolInfo[]> {
    const request = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/list",
    };

    const response = await fetch(this.config.url!, {
      method: "POST",
      headers: {
        Accept: MCP_ACCEPT_HEADER,
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify(request),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`MCP listTools failed: ${response.status} ${text}`);
    }

    const result = await response.json();
    if (result.error) {
      throw new Error(result.error.message);
    }
    return result.result?.tools || [];
  }

  /** Вызов тула через POST; ответ приходит в SSE-потоке по id. */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const id = ++this.seq;
    const request = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    return new Promise((resolve, reject) => {
      const settle = (fn: () => void) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        fn();
      };
      const timeout = this.config.timeout || 30000;
      const timer = setTimeout(() => settle(() => reject(new Error("MCP call timeout"))), timeout);
      this.pending.set(id, { resolve, reject, timer });

      fetch(this.config.url!, {
        method: "POST",
        headers: {
          Accept: MCP_ACCEPT_HEADER,
          "Content-Type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify(request),
        signal: this.abortController?.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            settle(() => reject(new Error(`MCP POST failed: ${response.status} ${text}`)));
            return;
          }
          const result = await response.json();
          settle(() =>
            result.error ? reject(new Error(result.error.message)) : resolve(result.result || result),
          );
        })
        .catch((err) => {
          if (err.name !== "AbortError") settle(() => reject(err));
        });
    });
  }
}
