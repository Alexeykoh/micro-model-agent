// Модуль MCP: ленивый коннект к серверам, discovery тулов, дефиниции, cleanup.
import type { PromptBlock } from "../../core/types";
import type { AgentModule, AgentPlugin } from "../types";
import type { ToolDefinition } from "../../tools/types";
import type { AppConfig } from "../../config/types";
import { MCPClient } from "./client";
import { MCPRegistry, type MCPServerConfig } from "./registry";
import type { Logger } from "../../logger/app-logger";
import { MCP_DISCOVERY_TIMEOUT_MS as DISCOVERY_TIMEOUT_MS } from "../../config/timeouts";
import { machinePolicyContext } from "../security/data-policy/context";
import { isExternalServiceUrl, projectOutboundDeep } from "../security/data-policy/outbound";
import {
  MCP_TOOL_SECURITY,
  mcpToolSecurity,
  sanitizeToolName,
  convertInputSchema,
  buildMcpPromptBlock,
  type DiscoveredTool,
} from "./tool-shape";

/** Модуль MCP: конфиги при init, коннект лениво, тул-дефиниции из найденного. */
export class MCPModule implements AgentModule {
  readonly name = "mcp";

  private connections: Map<string, MCPClient> = new Map();
  /** Конфиги серверов с init, ещё без коннекта. */
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private discovered: DiscoveredTool[] = [];
  private initialized = false;
  /** Серверы с упавшим первичным discovery — не ретраятся. */
  private failedServers: Set<string> = new Set();

  constructor(
    private config: AppConfig,
    /** Логгер bootstrap-модуля: привязан к каталогам, иначе warn не персистится. */
    private logger?: Logger,
  ) {}

  getFailedServers(): string[] {
    return [...this.failedServers];
  }
  /** Честный health: упавшие серверы → degraded (INV-6). */
  health(): { status: "ok" | "degraded" | "failed"; reason?: string } {
    if (this.failedServers.size > 0) {
      return { status: "degraded", reason: `mcp servers failed: ${[...this.failedServers].join(", ")}` };
    }
    return { status: "ok" };
  }

  /** Регистрация конфигов БЕЗ коннекта (ленивый discovery на первом вызове). */
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

    // Конфиги — для ленивого коннекта, сетевых вызовов тут нет.
    for (const serverName of registry.list()) {
      this.serverConfigs.set(serverName, registry.get(serverName)!);
    }

    // Discovery ДО снапшота тул-дефиниций вызывающим. Раньше был
    // fire-and-forget, и `collectToolDefinitions()` при bootstrap отрабатывал
    // раньше, чем серверы успевали подключиться, — настоящие MCP-тулы не
    // регистрировались. Discovery ограничен (таймаут на сервер, серверы
    // параллельно) и best-effort: падения оставляют ленивый плейсхолдер "connect".
    await this.discoverAllTools();
  }

  /** Параллельный discovery каждого сервера (таймаут DISCOVERY_TIMEOUT_MS). */
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
              if (timedOut) return; // проиграл гонку — состояние не мутировать
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
        } catch (e: unknown) {
          timedOut = true;
          this.failedServers.add(serverName);
          this.logger?.warn(`MCP server "${serverName}" init failed: ${e instanceof Error ? e.message : String(e)}`);
          await client.disconnect().catch((err: unknown) => {
            this.logger?.warn(`cleanup disconnect for "${serverName}" failed`, {
              error: String(err),
            });
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }

  /**
   * Гарантировать коннект конкретного сервера и discovery его тулов.
   * Лениво вызывается на первом обращении к тулу сервера.
   */
  private async ensureConnected(serverName: string): Promise<MCPClient | null> {
    // Уже подключён?
    const existing = this.connections.get(serverName);
    if (existing?.isConnected()) return existing;

    // Упал при init — не ретраить.
    if (this.failedServers.has(serverName)) return null;

    const serverConfig = this.serverConfigs.get(serverName);
    if (!serverConfig) return null;

    const client = new MCPClient(serverConfig);
    try {
      await client.connect();
      const tools = await client.listTools();
      this.connections.set(serverName, client);

      // Добавить новонайденные тулы (если ещё нет).
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
    } catch (e: unknown) {
      this.failedServers.add(serverName);
      this.logger?.warn(`MCP connect failed for "${serverName}": ${e instanceof Error ? e.message : String(e)}`);
      await client.disconnect().catch(() => {});
      return null;
    }
  }

  getSystemPromptBlock(): PromptBlock | null {
    return buildMcpPromptBlock([...this.serverConfigs.keys()], this.discovered);
  }

  getToolDefinitions(): ToolDefinition[] {
    // Дефиниции из найденных + зарегистрированных (видимые даже при падении discovery).
    const defs: ToolDefinition[] = [];
    // Санитизация схлопывает имена (`a.b`/`a-b`); суффикс до регистрации.
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

    // Уже найденные тулы (подключены при старте).
    for (const d of this.discovered) {
      defs.push({
        name: uniqueName(sanitizeToolName(d.serverName, d.toolName)),
        description: `${d.description} [MCP server: ${d.serverName}]`,
        parameters: convertInputSchema(d.inputSchema),
        tags: ["mcp"],
        security: mcpToolSecurity(d.inputSchema),
        handler: async (ctx, args) => {
          const client = this.connections.get(d.serverName);
          if (!client?.isConnected()) {
            return {
              success: false,
              output: `MCP server "${d.serverName}" not connected`,
            };
          }
          try {
            // Внешний MCP: аргументы проецируются до сети (без псевдонимов).
            const dp = ctx.config?.security?.dataPolicy;
            const cfg = this.serverConfigs.get(d.serverName);
            const callArgs =
              dp?.enabled && isExternalServiceUrl(cfg?.url)
                ? projectOutboundDeep(
                    args,
                    dp,
                    { kind: "api", trusted: false },
                    machinePolicyContext(ctx.baseDir),
                  ).value
                : args;
            const result = await client.callTool(d.toolName, callArgs);
            return {
              success: true,
              output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            };
          } catch (e: unknown) {
            return { success: false, output: `MCP call failed: ${e instanceof Error ? e.message : String(e)}` };
          }
        },
      });
    }

    // Ещё не найденные серверы — плейсхолдеры, коннект лениво на первом вызове.
    for (const [serverName] of this.serverConfigs) {
      if (this.failedServers.has(serverName)) continue;
      const alreadyDiscovered = this.discovered.some((d) => d.serverName === serverName);
      if (alreadyDiscovered) continue;

      // Один тул "connect", чтобы модель могла триггернуть discovery.
      defs.push({
        name: uniqueName(sanitizeToolName(serverName, "connect")),
        description: `Connect to MCP server "${serverName}" and discover its tools`,
        parameters: { type: "object", properties: {} },
        tags: ["mcp"],
        security: MCP_TOOL_SECURITY,
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
            output:
              tools.length > 0
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
      description: "connects MCP servers and exposes their tools",
      priority: 0,
      onSessionEnd: async () => {
        for (const [serverName, client] of this.connections) {
          try {
            await client.disconnect();
          } catch (e: unknown) {
            // Best-effort cleanup на конце сессии: упавший disconnect не
            // должен ронять shutdown, но обязан остаться в диагностике.
            this.logger?.warn(`disconnect from "${serverName}" failed`, {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      },
    };
  }
}
