// HTTP-транспорт MCP: POST JSON-RPC без постоянного соединения.
// Вынесено из `client.ts` (правило ≤300): клиент — диспетчер, транспорт — протокол.
import type { MCPServerConfig } from "./registry";
import { MCP_HTTP_TIMEOUT_MS as HTTP_TIMEOUT_MS } from "../../config/timeouts";
import { MCP_ACCEPT_HEADER, type MCPToolInfo } from "./protocol";
import { oauthHeaders, refreshToken, resolveTokenFile } from "./oauth";

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

  /** POST JSON-RPC с OAuth-заголовками: 401 → refresh 1 раз → повтор. */
  private async post(request: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: MCP_ACCEPT_HEADER,
      "Content-Type": "application/json",
      ...this.config.headers,
      ...(await oauthHeaders(this.config, process.cwd())),
    };
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.config.timeout || HTTP_TIMEOUT_MS),
    };
    const first = await fetch(this.config.url!, init);
    if (first.status !== 401 || !this.config.oauth?.tokenUrl) return first;
    const filePath = resolveTokenFile(this.config, process.cwd());
    if (!filePath) return first;
    const fresh = await refreshToken(filePath, this.config.oauth.tokenUrl, this.config.oauth.clientId ?? "");
    if (!fresh) return first;
    headers.Authorization = `Bearer ${fresh}`;
    return fetch(this.config.url!, init);
  }

  /** Список тулов через HTTP POST. */
  async listTools(): Promise<MCPToolInfo[]> {
    const request = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/list",
    };

    const response = await this.post(request);

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

    const response = await this.post(request);

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
