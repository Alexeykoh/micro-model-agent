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

/** Timeout for the initial tool discovery call (avoids hanging startup). */
const DISCOVERY_TIMEOUT_MS = 5_000;

export class MCPModule implements AgentModule {
  readonly name = "mcp";

  private connections: Map<string, MCPClient> = new Map();
  /** Server configs registered at init, not yet connected. */
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private discovered: DiscoveredTool[] = [];
  private initialized = false;
  private initError: string | null = null;
  /** Servers that failed initial discovery — will not be retried. */
  private failedServers: Set<string> = new Set();

  constructor(private config: AppConfig) {}

  /**
   * Register MCP server configs WITHOUT connecting. Actual connection and tool
   * discovery happens lazily on first tool call — keeps startup fast and
   * offline-safe.
   */
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

    // Store configs for lazy connection — no network calls here.
    for (const serverName of registry.list()) {
      this.serverConfigs.set(serverName, registry.get(serverName)!);
    }

    // Discover tools BEFORE the caller snapshots tool definitions. This used
    // to be fire-and-forget, so `collectToolDefinitions()` at bootstrap ran
    // before any server finished connecting and the real MCP tools were never
    // registered. Discovery is bounded (per-server timeout, servers in
    // parallel) and best-effort: failures leave the lazy "connect" placeholder.
    await this.discoverAllTools();
  }

  /**
   * Try to connect and discover tools for all registered servers, in parallel,
   * each bounded by DISCOVERY_TIMEOUT_MS. A timed-out attempt is cancelled: its
   * late completion must not register a server already marked failed.
   */
  private async discoverAllTools(): Promise<void> {
    await Promise.all(
      [...this.serverConfigs].map(async ([serverName, serverConfig]) => {
        if (this.failedServers.has(serverName)) return;

        const client = new MCPClient(serverConfig);
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
          await Promise.race([
            (async () => {
              await client.connect();
              const tools = await client.listTools();
              if (timedOut) return; // lost the race — do not mutate state
              this.connections.set(serverName, client);
              for (const tool of tools) {
                this.discovered.push({
                  serverName,
                  toolName: tool.name,
                  description: tool.description || `Tool on MCP server "${serverName}"`,
                  inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
                });
              }
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("discovery timeout")),
                DISCOVERY_TIMEOUT_MS,
              );
            }),
          ]);
        } catch (e: any) {
          timedOut = true;
          this.failedServers.add(serverName);
          this.initError = `MCP server "${serverName}" init failed: ${e.message}`;
          await client.disconnect().catch((err: unknown) => {
            logger.warn(`cleanup disconnect for "${serverName}" failed`, { error: String(err) });
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }

  /**
   * Ensure a specific server is connected and its tools are discovered.
   * Called lazily on first tool invocation for that server.
   */
  private async ensureConnected(serverName: string): Promise<MCPClient | null> {
    // Already connected?
    const existing = this.connections.get(serverName);
    if (existing?.isConnected()) return existing;

    // Failed during init — don't retry.
    if (this.failedServers.has(serverName)) return null;

    const serverConfig = this.serverConfigs.get(serverName);
    if (!serverConfig) return null;

    const client = new MCPClient(serverConfig);
    try {
      await client.connect();
      const tools = await client.listTools();
      this.connections.set(serverName, client);

      // Add newly discovered tools (if not already present).
      for (const tool of tools) {
        const alreadyDiscovered = this.discovered.some(
          (d) => d.serverName === serverName && d.toolName === tool.name,
        );
        if (!alreadyDiscovered) {
          this.discovered.push({
            serverName,
            toolName: tool.name,
            description: tool.description || `Tool on MCP server "${serverName}"`,
            inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
          });
        }
      }
      return client;
    } catch (e: any) {
      this.failedServers.add(serverName);
      logger.warn(`MCP connect failed for "${serverName}": ${e.message}`);
      await client.disconnect().catch(() => {});
      return null;
    }
  }

  getSystemPromptBlock(): PromptBlock | null {
    const serverNames = [...this.serverConfigs.keys()];
    if (serverNames.length === 0) return null;

    const lines: string[] = ["---", "MCP servers available:"];

    const byServer = new Map<string, DiscoveredTool[]>();
    for (const d of this.discovered) {
      const list = byServer.get(d.serverName) || [];
      list.push(d);
      byServer.set(d.serverName, list);
    }

    for (const serverName of serverNames) {
      lines.push(`  [${serverName}]`);
      const tools = byServer.get(serverName);
      if (tools && tools.length > 0) {
        for (const t of tools) {
          const toolRef = sanitizeToolName(serverName, t.toolName);
          lines.push(`    - ${toolRef}: ${t.description}`);
        }
      } else {
        lines.push(
          `    (not yet connected — use ${sanitizeToolName(serverName, "connect")} to discover tools)`,
        );
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
    // Build definitions from discovered tools AND from registered-but-not-yet-discovered
    // servers (so the LLM sees all configured MCP tools even if discovery failed at startup).
    const defs: ToolDefinition[] = [];

    // Sanitization can collapse distinct names to the same id (`a.b`/`a-b`,
    // `x.y`/`x-y`); the registry throws on a duplicate, which used to crash
    // bootstrap. Disambiguate with a numeric suffix before registering.
    const usedNames = new Set<string>();
    const uniqueName = (base: string): string => {
      if (!usedNames.has(base)) {
        usedNames.add(base);
        return base;
      }
      let i = 2;
      while (usedNames.has(`${base}_${i}`)) i++;
      const name = `${base}_${i}`;
      usedNames.add(name);
      return name;
    };

    // Tools already discovered (connected at startup).
    for (const d of this.discovered) {
      defs.push({
        name: uniqueName(sanitizeToolName(d.serverName, d.toolName)),
        description: `${d.description} [MCP server: ${d.serverName}]`,
        parameters: convertInputSchema(d.inputSchema),
        tags: ["code", "research"],
        handler: async (_ctx, args) => {
          const client = this.connections.get(d.serverName);
          if (!client?.isConnected()) {
            return {
              success: false,
              output: `MCP server "${d.serverName}" not connected`,
            };
          }
          try {
            const result = await client.callTool(d.toolName, args);
            return {
              success: true,
              output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            };
          } catch (e: any) {
            return { success: false, output: `MCP call failed: ${e.message}` };
          }
        },
      });
    }

    // Servers that haven't been discovered yet — register placeholder tools
    // that will connect lazily on first call.
    for (const [serverName] of this.serverConfigs) {
      if (this.failedServers.has(serverName)) continue;
      const alreadyDiscovered = this.discovered.some((d) => d.serverName === serverName);
      if (alreadyDiscovered) continue;

      // Register a single "connect" tool so the LLM can trigger discovery.
      defs.push({
        name: uniqueName(sanitizeToolName(serverName, "connect")),
        description: `Connect to MCP server "${serverName}" and discover its tools`,
        parameters: { type: "object", properties: {} },
        tags: ["code", "research"],
        handler: async (_ctx, _args) => {
          const client = await this.ensureConnected(serverName);
          if (!client) {
            return { success: false, output: `MCP server "${serverName}" connection failed` };
          }
          const tools = this.discovered
            .filter((d) => d.serverName === serverName)
            .map((d) => `  - ${sanitizeToolName(serverName, d.toolName)}: ${d.description}`);
          return {
            success: true,
            output: tools.length > 0
              ? `Connected to "${serverName}". Tools:\n${tools.join("\n")}`
              : `Connected to "${serverName}" (no tools discovered)`,
          };
        },
      });
    }

    return defs;
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
