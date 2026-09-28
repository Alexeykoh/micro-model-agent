// Реестр MCP-серверов: конфиги по именам (регистрация/поиск/список/удаление).
/** Конфиг MCP-сервера: stdio-команда или sse/http-URL, заголовки, таймаут. */
export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: "stdio" | "sse" | "http";
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

/** Реестр конфигов MCP-серверов по именам. */
export class MCPRegistry {
  private servers: Map<string, MCPServerConfig> = new Map();

  /** Зарегистрировать конфиг сервера. */
  register(config: MCPServerConfig): void {
    this.servers.set(config.name, config);
  }

  /** Конфиг по имени (undefined — нет). */
  get(name: string): MCPServerConfig | undefined {
    return this.servers.get(name);
  }

  /** Имена серверов по алфавиту. */
  list(): string[] {
    return Array.from(this.servers.keys()).sort();
  }

  /** Удалить сервер. */
  remove(name: string): void {
    this.servers.delete(name);
  }
}
