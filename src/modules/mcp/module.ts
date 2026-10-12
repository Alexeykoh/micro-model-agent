// Модуль MCP: ленивый коннект к серверам, discovery тулов, дефиниции, cleanup.
import type { PromptBlock } from "../../core/types";
import type { AgentModule, AgentPlugin } from "../types";
import type { ToolDefinition } from "../../tools/types";
import type { AppConfig } from "../../config/types";
import { MCPClient } from "./client";
import { MCPRegistry, type MCPServerConfig } from "./registry";
import { Logger } from "../../logger/app-logger";
import { MCP_DISCOVERY_TIMEOUT_MS as DISCOVERY_TIMEOUT_MS } from "../../config/timeouts";
import {
  MCP_TOOL_SECURITY,
  sanitizeToolName,
  convertInputSchema,
  buildMcpPromptBlock,
  type DiscoveredTool,
} from "./tool-shape";

const logger = new Logger("warn", "mcp");

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

  constructor(private config: AppConfig) {}

  /**
   * Зарегистрировать конфиги MCP-серверов БЕЗ коннекта. Коннект и discovery
   * тулов — лениво, на первом вызове: старт быстрый и офлайн-безопасный.
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

  /**
   * Подключиться и найти тулы всех зарегистрированных серверов параллельно,
   * каждый ограничен DISCOVERY_TIMEOUT_MS. Отменённая по таймауту попытка:
   * её позднее завершение не должно регистрировать сервер, уже помеченный упавшим.
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
        } catch (e: any) {
          timedOut = true;
          this.failedServers.add(serverName);
          logger.warn(`MCP server "${serverName}" init failed: ${e.message}`);
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
    } catch (e: any) {
      this.failedServers.add(serverName);
      logger.warn(`MCP connect failed for "${serverName}": ${e.message}`);
      await client.disconnect().catch(() => {});
      return null;
    }
  }

  getSystemPromptBlock(): PromptBlock | null {
    return buildMcpPromptBlock([...this.serverConfigs.keys()], this.discovered);
  }

  getToolDefinitions(): ToolDefinition[] {
    // Дефиниции из найденных тулов И из зарегистрированных, но ещё не
    // найденных серверов (модель видит все настроенные MCP-тулы, даже если
    // discovery при старте упал).
    const defs: ToolDefinition[] = [];

    // Санитизация может схлопнуть разные имена в один id (`a.b`/`a-b`,
    // `x.y`/`x-y`); реестр на дубле бросал, что роняло bootstrap.
    // Разруливаем числовым суффиксом до регистрации.
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
        tags: ["code", "research"],
        security: MCP_TOOL_SECURITY,
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
        tags: ["code", "research"],
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
            // Best-effort cleanup на конце сессии: упавший disconnect не
            // должен ронять shutdown, но обязан остаться в диагностике.
            logger.warn(`disconnect from "${serverName}" failed`, { error: String(e?.message ?? e) });
          }
        }
      },
    };
  }
}
