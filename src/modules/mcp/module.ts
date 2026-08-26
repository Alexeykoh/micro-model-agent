import type { PromptBlock } from "../../core/types";
import type { AgentModule, AgentPlugin } from "../types";
import type { ToolDefinition } from "../../tools/types";
import type { AppConfig } from "../../config/types";
import { MCPClient } from "./client";
import { MCPRegistry, type MCPServerConfig } from "./registry";
import { Logger } from "../../logger/app-logger";

const logger = new Logger("warn", "mcp");

interface DiscoveredTool {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function sanitizeToolName(server: string, tool: string): string {
  const safeServer = server.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${safeServer}__${safeTool}`;
}

function convertInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && typeof schema === "object" && "properties" in schema) {
    const required = Array.isArray((schema as any).required) ? (schema as any).required : [];
    return {
      type: "object",
      properties: (schema as any).properties,
      required: required.length > 0 ? required : undefined,
    };
  }
  return { type: "object", properties: {} };
}

export class MCPModule implements AgentModule {
  readonly name = "mcp";

  private connections: Map<string, MCPClient> = new Map();
  private discovered: DiscoveredTool[] = [];
  private initialized = false;
  private initError: string | null = null;

  constructor(private config: AppConfig) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const servers = this.config.mcpServers || {};
    const serverEntries = Object.entries(servers).filter(([, cfg]) => cfg.enabled !== false);

    if (serverEntries.length === 0) return;

    const registry = new MCPRegistry();

    for (const [key, cfg] of serverEntries) {
      const serverConfig: MCPServerConfig = {
        name: cfg.name || key,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        transport: cfg.transport,
        url: cfg.url,
        headers: cfg.headers,
        timeout: cfg.timeout,
      };
      registry.register(serverConfig);
    }

    for (const serverName of registry.list()) {
      const serverConfig = registry.get(serverName)!;
      const client = new MCPClient(serverConfig);

      try {
        await client.connect();
        const tools = await client.listTools();
        this.connections.set(serverName, client);

        for (const tool of tools) {
          this.discovered.push({
            serverName,
            toolName: tool.name,
            description: tool.description || `Tool on MCP server "${serverName}"`,
            inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
          });
        }
      } catch (e: any) {
        this.initError = `MCP server "${serverName}" init failed: ${e.message}`;
        await client.disconnect().catch((err: unknown) => {
          logger.warn(`cleanup disconnect for "${serverName}" failed`, { error: String(err) });
        });
      }
    }
  }

  getSystemPromptBlock(): PromptBlock | null {
    if (this.discovered.length === 0) return null;

    const lines: string[] = ["---", "MCP servers available:"];

    const byServer = new Map<string, DiscoveredTool[]>();
    for (const d of this.discovered) {
      const list = byServer.get(d.serverName) || [];
      list.push(d);
      byServer.set(d.serverName, list);
    }

    for (const [server, tools] of byServer) {
      lines.push(`  [${server}]`);
      for (const t of tools) {
        const toolRef = sanitizeToolName(server, t.toolName);
        lines.push(`    - ${toolRef}: ${t.description}`);
      }
    }

    lines.push("---");

    return {
      content: lines.join("\n"),
      priority: "high",
      essential: false,
      estimatedTokens: this.discovered.length * 20 + 20,
    };
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.discovered.map((d) => ({
      name: sanitizeToolName(d.serverName, d.toolName),
      description: `${d.description} [MCP server: ${d.serverName}]`,
      parameters: convertInputSchema(d.inputSchema),
      tags: ["code", "research"],
      handler: async (_ctx, args) => {
        const client = this.connections.get(d.serverName);
        if (!client) {
          return {
            success: false,
            output: `MCP server "${d.serverName}" not connected`,
          };
        }

        try {
          if (!client.isConnected()) {
            await client.connect();
          }
          const result = await client.callTool(d.toolName, args);
          return {
            success: true,
            output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          };
        } catch (e: any) {
          return { success: false, output: `MCP call failed: ${e.message}` };
        }
      },
    }));
  }

  getPlugin(): AgentPlugin {
    return {
      name: "mcp_module",
      priority: 0,
      onSessionEnd: async () => {
        for (const [serverName, client] of this.connections) {
          try {
            await client.disconnect();
          } catch (e: any) {
            // Best-effort cleanup at session end — a failed disconnect must
            // not crash the shutdown path, but must stay diagnosable.
            logger.warn(`disconnect from "${serverName}" failed`, { error: String(e?.message ?? e) });
          }
        }
      },
    };
  }
}
