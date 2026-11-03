// HTTP-транспорт MCP: POST JSON-RPC без постоянного соединения.
// Вынесено из `client.ts` (правило ≤300): клиент — диспетчер, транспорт — протокол.
import type { MCPServerConfig } from "./registry";
import { MCP_HTTP_TIMEOUT_MS as HTTP_TIMEOUT_MS } from "../../config/timeouts";
import { MCP_ACCEPT_HEADER, type MCPToolInfo } from "./protocol";

/** HTTP-транспорт одного MCP-сервера: listTools/callTool через POST. */
export class HttpTransport {
  private connected = false;

  constructor(private readonly config: MCPServerConfig) {}

  /** Есть ли соединение (у HTTP это только флаг). */
  isConnected(): boolean {
    return this.connected;
  }

  /** HTTP-транспорт без постоянного соединения: достаточно флага. */
  connect(): void {
    this.connected = true;
  }

  /** Сбросить флаг соединения. */
  disconnect(): void {
    this.connected = false;
  }

  /** Список тулов через HTTP POST. */
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

  /** Вызов тула через HTTP POST. */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
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
}
