import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext } from "./types";
import { MCPClient } from "../modules/mcp/client";
import { MCPRegistry } from "../modules/mcp/registry";

const registry = new MCPRegistry();
let initialized = false;

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

export const mcpCallTool: ToolDefinition = {
  name: "mcp_call",
  description:
    "Call a tool on an MCP (Model Context Protocol) server. MCP servers provide external capabilities like databases, APIs, or specialized tools.",
  tags: ["code", "research"],
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
        output: `MCP server "${serverName}" not found. Available: ${available.join(", ") || "(none)"}`,
      };
    }

    try {
      const client = new MCPClient(serverConfig);
      await client.connect();

      const result = await client.callTool(toolName, toolArgs);

      await client.disconnect();

      return {
        success: true,
        output: `MCP call result:\n${JSON.stringify(result, null, 2)}`,
      };
    } catch (e: any) {
      return { success: false, output: `MCP call failed: ${e.message}` };
    }
  },
};
