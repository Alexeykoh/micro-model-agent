/** Тул вызова тула на MCP-сервере (ленивая регистрация из конфига). */
import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext } from "./types";
import { MCPClient } from "../modules/mcp/client";
import { MCPRegistry } from "../modules/mcp/registry";

const registry = new MCPRegistry();
let initialized = false;

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
      });
    }
  }
}

/** Вызывает тул на MCP-сервере. Параметры: server, tool, args. */
export const mcpCallTool: ToolDefinition = {
  name: "mcp_call",
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
    try {
      await client.connect();
      const result = await client.callTool(toolName, toolArgs);
      return {
        success: true,
        output: `MCP call result:\n${JSON.stringify(result, null, 2)}`,
      };
    } catch (e: any) {
      return { success: false, output: t("tool.mcp_call_failed", { error: e.message }) };
    } finally {
      // Клиент закрывать всегда: раньше ошибка/таймаут в callTool пропускала
      // disconnect и сиротила stdio-дочерний процесс на сессию.
      await client.disconnect().catch(() => {});
    }
  },
};
