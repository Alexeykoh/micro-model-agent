import { spawn, ChildProcess } from "child_process";
import type { MCPServerConfig } from "./registry";

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

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...this.config.headers,
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    this._connected = true;

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    this.readSSE(reader, decoder, buffer);
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
        if (msg.error) {
          this.pendingReject?.(new Error(msg.error.message));
        } else {
          this.pendingResolve(msg.result);
        }
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    } catch {}
  }

  private handleSSEError(err: Error): void {
    if (this.pendingReject) {
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
        _resolved = true;
        resolve();
      });
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
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify(request),
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

    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/list",
      };

      const requestStr = JSON.stringify(request) + "\n";
      this.process!.stdin!.write(requestStr);

      let responseData = "";
      const onData = (data: Buffer) => {
        responseData += data.toString();
        if (responseData.includes("\n")) {
          this.process!.stdout!.off("data", onData);
          try {
            const lines = responseData.split("\n").filter((l) => l.trim());
            for (const line of lines) {
              const response = JSON.parse(line);
              if (response.id === request.id) {
                if (response.error) {
                  reject(new Error(response.error.message));
                } else {
                  resolve(response.result?.tools || []);
                }
                return;
              }
            }
            reject(new Error("No matching response found"));
          } catch (e: any) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        }
      };

      this.process!.stdout!.on("data", onData);
      setTimeout(() => {
        this.process!.stdout!.off("data", onData);
        reject(new Error("MCP listTools timeout"));
      }, 30000);
    });
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
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify(request),
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
      const timer = setTimeout(() => {
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(new Error("MCP call timeout"));
      }, timeout);

      fetch(this.config.url!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify(request),
        signal: this.abortController?.signal,
      })
        .then(async (response) => {
          clearTimeout(timer);
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
          clearTimeout(timer);
          if (err.name !== "AbortError") {
            reject(err);
          }
        });
    });
  }

  private callToolStdio(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.process) {
      throw new Error("Not connected to MCP server");
    }

    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      };

      const requestStr = JSON.stringify(request) + "\n";

      this.process!.stdin!.write(requestStr);

      let responseData = "";

      const onData = (data: Buffer) => {
        responseData += data.toString();

        if (responseData.includes("\n")) {
          this.process!.stdout!.off("data", onData);

          try {
            const lines = responseData.split("\n").filter((l) => l.trim());
            for (const line of lines) {
              const response = JSON.parse(line);
              if (response.id === request.id) {
                if (response.error) {
                  reject(new Error(response.error.message));
                } else {
                  resolve(response.result);
                }
                return;
              }
            }
            reject(new Error("No matching response found"));
          } catch (e: any) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        }
      };

      this.process!.stdout!.on("data", onData);

      setTimeout(() => {
        this.process!.stdout!.off("data", onData);
        reject(new Error("MCP call timeout"));
      }, 30000);
    });
  }
}
