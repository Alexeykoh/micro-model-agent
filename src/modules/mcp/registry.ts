export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: "stdio" | "sse";
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export class MCPRegistry {
  private servers: Map<string, MCPServerConfig> = new Map();

  register(config: MCPServerConfig): void {
    this.servers.set(config.name, config);
  }

  get(name: string): MCPServerConfig | undefined {
    return this.servers.get(name);
  }

  list(): string[] {
    return Array.from(this.servers.keys()).sort();
  }

  remove(name: string): void {
    this.servers.delete(name);
  }
}
