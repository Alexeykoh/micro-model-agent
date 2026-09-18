import { spawn, ChildProcess } from "child_process";
import type { MCPServerConfig } from "./registry";
import { defaultOutputBus } from "../../output";

/** Default timeout for MCP HTTP requests (connect + tool calls). */
const HTTP_TIMEOUT_MS = 10_000;

/**
 * Accept header required by the MCP Streamable HTTP transport — the server
 * responds with 406 if the client doesn't accept both media types.
 */
const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

export class MCPClient {
  readonly serverName: string;
  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private _connected = false;
  private abortController: AbortController | null = null;
  private pendingResolve: ((value: unknown) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.serverName = config.name;
  }

  isConnected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    if (this.config.transport === "http") {
      this._connected = true;
      return;
    }
    if (this.config.transport === "sse" || this.config.url) {
      return this.connectSSE();
    }
    return this.connectStdio();
  }

  private async connectSSE(): Promise<void> {
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

      this._connected = true;

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
      while (this._connected) {
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
              this.handleSSEMessage(data);
            }
            eventType = "";
            data = "";
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        this.handleSSEError(err);
      }
    }
    this._connected = false;
  }

  private handleSSEMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (this.pendingResolve && msg.id) {
        this.clearSseTimer();
        if (msg.error) {
          this.pendingReject?.(new Error(msg.error.message));
        } else {
          this.pendingResolve(msg.result);
        }
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    } catch (e) {
      // Heartbeats/comments are not JSON — expected noise, but still logged
      // so a genuinely broken stream is visible in diagnostics.
      defaultOutputBus.log(
        "error",
        "mcp",
        `[MCPClient] Unparseable SSE message: ${String(data).slice(0, 120)} ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private handleSSEError(err: Error): void {
    if (this.pendingReject) {
      this.clearSseTimer();
      this.pendingReject(err);
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  }

  private connectStdio(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.command!, this.config.args || [], {
        env: { ...process.env, ...this.config.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let _resolved = false;
      child.on("error", (err) => {
        this._connected = false;
        if (!_resolved) {
          _resolved = true;
          reject(err);
        }
      });

      child.on("exit", (code) => {
        this._connected = false;
        if (code !== 0 && !_resolved) {
          _resolved = true;
          reject(new Error(`MCP server exited with code ${code}`));
        }
      });

      child.on("spawn", () => {
        this._connected = true;
        this.process = child;
        // MCP handshake: real servers require `initialize` before any
        // tools/list or tools/call request.
        this.stdioRequest(
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
              JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
            );
          })
          .then(() => {
            _resolved = true;
            resolve();
          })
          .catch((err) => {
            this._connected = false;
            if (!_resolved) {
              _resolved = true;
              reject(err);
            }
          });
      });
    });
  }

  /** Unparsed trailing bytes from stdio responses (partial line). */
  private stdioBuffer = "";

  /**
   * JSON-RPC request over stdio with timeout, exit handling and
   * buffer-aware line parsing (notifications and stale responses between
   * our request and its response no longer break matching).
   */
  private stdioRequest<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const proc = this.process;
    if (!proc || !proc.stdout || !proc.stdin) {
      return Promise.reject(new Error("Not connected to MCP server"));
    }
    const stdout = proc.stdout;
    const timeout = timeoutMs ?? this.config.timeout ?? 30000;

    return new Promise<T>((resolve, reject) => {
      const request = {
        jsonrpc: "2.0",
        id: Date.now(),
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
        this.stdioBuffer += data.toString();
        let idx: number;
        while ((idx = this.stdioBuffer.indexOf("\n")) !== -1 && !settled) {
          const line = this.stdioBuffer.slice(0, idx).trim();
          this.stdioBuffer = this.stdioBuffer.slice(idx + 1);
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
          if (msg.id !== request.id) continue; // notification or foreign response
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

      proc.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  async listTools(): Promise<
    Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>
  > {
    if (!this._connected) {
      await this.connect();
    }

    if (this.config.transport === "http") {
      return this.listToolsHTTP();
    }
    if (this.config.transport === "sse" || this.config.url) {
      return this.listToolsSSE();
    }
    return this.listToolsStdio();
  }

  private async listToolsHTTP(): Promise<
    Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>
  > {
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
      signal: AbortSignal.timeout(this.config.timeout || HTTP_TIMEOUT_MS),
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

  private async listToolsSSE(): Promise<
    Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>
  > {
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

  private async listToolsStdio(): Promise<
    Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>
  > {
    if (!this.process) {
      throw new Error("Not connected to MCP server");
    }

    const result = await this.stdioRequest<{
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
    }>("tools/list");

    return result?.tools || [];
  }

  async disconnect(): Promise<void> {
    if (this.config.transport === "http") {
      this._connected = false;
      return;
    }
    if (this.config.transport === "sse" || this.config.url) {
      this.abortController?.abort();
      this.abortController = null;
    } else if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this._connected = false;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this._connected) {
      throw new Error("Not connected to MCP server");
    }

    if (this.config.transport === "http") {
      return this.callToolHTTP(toolName, args);
    }
    if (this.config.transport === "sse" || this.config.url) {
      return this.callToolSSE(toolName, args);
    }
    return this.callToolStdio(toolName, args);
  }

  private async callToolHTTP(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const request = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const response = await fetch(this.config.url!, {
      method: "POST",
      headers: {
        Accept: MCP_ACCEPT_HEADER,
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.config.timeout || HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`MCP call failed: ${response.status} ${text}`);
    }

    const result = await response.json();
    if (result.error) {
      throw new Error(result.error.message);
    }
    return result.result || result;
  }

  /** Timer of the in-flight SSE request — cleared when the reply arrives via the stream. */
  private sseTimer: ReturnType<typeof setTimeout> | undefined;

  private async callToolSSE(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const request = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      const timeout = this.config.timeout || 30000;
      this.sseTimer = setTimeout(() => {
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(new Error("MCP call timeout"));
      }, timeout);

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
          this.clearSseTimer();
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            reject(new Error(`MCP POST failed: ${response.status} ${text}`));
            return;
          }
          const result = await response.json();
          if (result.error) {
            reject(new Error(result.error.message));
          } else {
            resolve(result.result || result);
          }
        })
        .catch((err) => {
          this.clearSseTimer();
          if (err.name !== "AbortError") {
            reject(err);
          }
        });
    });
  }

  private clearSseTimer(): void {
    if (this.sseTimer !== undefined) {
      clearTimeout(this.sseTimer);
      this.sseTimer = undefined;
    }
  }

  private callToolStdio(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.process) {
      throw new Error("Not connected to MCP server");
    }

    return this.stdioRequest("tools/call", {
      name: toolName,
      arguments: args,
    });
  }
}
