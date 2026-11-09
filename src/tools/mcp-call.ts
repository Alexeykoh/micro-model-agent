/** Тул вызова тула на MCP-сервере (ленивая регистрация из конфига). */
import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext } from "./types";
import { MCPClient } from "../modules/mcp/client";
import { MCPRegistry } from "../modules/mcp/registry";

const registry = new MCPRegistry();
let initialized = false;
/** Прошлый вызов на сервер (gateway rate-limit). */
const lastMcpCall = new Map<string, number>();

/** Ленивая регистрация MCP-серверов из конфига (один раз на процесс). */
function ensureInitialized(ctx: ToolContext): void {
  if (initialized) return;
  initialized = true;

  const servers = ctx.config.mcpServers || {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled !== false) {
      registry.register({
        name: cfg.name || name,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        transport: cfg.transport,
        url: cfg.url,
        headers: cfg.headers,
        timeout: cfg.timeout,
        rateLimitMs: cfg.rateLimitMs,
      });
    }
  }
}

/** Вызывает тул на MCP-сервере. Параметры: server, tool, args. */
export const mcpCallTool: ToolDefinition = {
  name: "mcp_call",
  security: { caps: [], manual: { reason: "mcp — произвольный сервер, политика у провайдера", reviewedBy: "architecture-v2", date: "2026-10-13" } },
  icon: "🔗",
  description:
    "Call a tool on an MCP (Model Context Protocol) server. MCP servers provide external capabilities like databases, APIs, or specialized tools.",
  tags: ["research"],
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "MCP server name" },
      tool: { type: "string", description: "Tool name on the server" },
      args: { type: "object", description: "Arguments to pass to the tool" },
    },
    required: ["server", "tool"],
  },
  handler: async (ctx: ToolContext, args) => {
    const serverName = String(args.server || "");
    const toolName = String(args.tool || "");
    const toolArgs = (args.args || {}) as Record<string, unknown>;

    if (!serverName || !toolName) {
      return { success: false, output: "Server and tool names are required" };
    }

    ensureInitialized(ctx);

    const serverConfig = registry.get(serverName);
    if (!serverConfig) {
      const available = registry.list();
      return {
        success: false,
        output: t("tool.mcp_server_not_found", {
          server: serverName,
          available: available.join(", ") || "(none)",
        }),
      };
    }

    const client = new MCPClient(serverConfig);
    // MCP gateway rate-limit (supply-chain MVP): один вызов на сервер не чаще
    // `rateLimitMs` из записи сервера (дефолт 0 — без лимита); лимит превышен —
    // честный отказ этого вызова (не спавнится новый транспорт).
    const rateLimitMs = serverConfig.rateLimitMs ?? 0;
    if (rateLimitMs > 0) {
      const now = Date.now();
      if (now - (lastMcpCall.get(serverName) ?? -Infinity) < rateLimitMs) {
        return { success: false, output: t("tool.mcp_rate_limited", { server: serverName }) };
      }
      lastMcpCall.set(serverName, now);
    }

    try {
      await client.connect();
      const result = await client.callTool(toolName, toolArgs);
      return {
        success: true,
        output: `MCP call result:\n${JSON.stringify(result, null, 2)}`,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, output: t("tool.mcp_call_failed", { error: message }) };
    } finally {
      // Клиент закрывать всегда: раньше ошибка/таймаут в callTool пропускала
      // disconnect и сиротила stdio-дочерний процесс на сессию.
      await client.disconnect().catch(() => {});
    }
  },
};
