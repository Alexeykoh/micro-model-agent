// MCP-клиент: диспетчер по транспорту (stdio/http/sse), listTools/callTool.
// Протоколы вынесены в транспорты (правило ≤300): client только выбирает путь.
import type { MCPServerConfig } from "./registry";
import { StdioTransport } from "./stdio-transport";
import { HttpTransport } from "./http-transport";
import { SseTransport } from "./sse-transport";
import type { MCPToolInfo } from "./protocol";

/** MCP-клиент: коннект по транспорту, listTools, callTool. */
export class MCPClient {
  readonly serverName: string;
  private config: MCPServerConfig;
  private stdio: StdioTransport;
  private http: HttpTransport;
  private sse: SseTransport;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.serverName = config.name;
    this.stdio = new StdioTransport(config);
    this.http = new HttpTransport(config);
    this.sse = new SseTransport(config);
  }

  /** HTTP-транспорт (POST без постоянного соединения). */
  private isHttp(): boolean {
    return this.config.transport === "http";
  }

  /** SSE-транспорт: явный `sse` или заданный `url` (http проверяется раньше). */
  private isSse(): boolean {
    return this.config.transport === "sse" || !!this.config.url;
  }

  /** Подключён ли клиент. */
  isConnected(): boolean {
    if (this.isHttp()) return this.http.isConnected();
    if (this.isSse()) return this.sse.isConnected();
    return this.stdio.isConnected();
  }

  /** Подключиться по транспорту из конфига (http/sse/stdio). */
  async connect(): Promise<void> {
    if (this.isConnected()) return;

    if (this.isHttp()) {
      this.http.connect();
      return;
    }
    if (this.isSse()) {
      return this.sse.connect();
    }
    return this.stdio.connect();
  }

  /** Список тулов сервера (автоконнект; транспорт выбирается из конфига). */
  async listTools(): Promise<MCPToolInfo[]> {
    if (!this.isConnected()) {
      await this.connect();
    }

    if (this.isHttp()) {
      return this.http.listTools();
    }
    if (this.isSse()) {
      return this.sse.listTools();
    }

    const result = await this.stdio.request<{ tools?: MCPToolInfo[] }>("tools/list");
    return result?.tools || [];
  }

  /** Отключиться: http/sse — сброс/abort, stdio — kill процесса. */
  async disconnect(): Promise<void> {
    if (this.isHttp()) {
      this.http.disconnect();
      return;
    }
    if (this.isSse()) {
      this.sse.disconnect();
      return;
    }
    this.stdio.disconnect();
  }

  /** Вызвать тул (без коннекта — ошибка; транспорт из конфига). */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected()) {
      throw new Error("Not connected to MCP server");
    }

    if (this.isHttp()) {
      return this.http.callTool(toolName, args);
    }
    if (this.isSse()) {
      return this.sse.callTool(toolName, args);
    }
    return this.stdio.request("tools/call", {
      name: toolName,
      arguments: args,
    });
  }
}
