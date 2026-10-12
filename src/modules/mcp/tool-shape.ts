// Форма MCP-тулов: имя, input-схема, security-декларация и промпт-блок —
// вынесено из `module.ts` (правило ≤300).
import type { PromptBlock } from "../../core/types";
import type { ToolSecurityDecl } from "../../tools/types";

/**
 * Политика MCP-тулов (INV-9/10): серверы произвольны и могут ходить в сеть или
 * запускать процессы, поэтому декларация — `manual` (enforcement внутри вызова).
 */
export const MCP_TOOL_SECURITY: ToolSecurityDecl = {
  caps: [],
  manual: {
    reason: "mcp — произвольный сервер, политика у провайдера",
    reviewedBy: "architecture-v2",
    date: "2026-10-13",
  },
};

/** Тул, найденный на MCP-сервере. */
export interface DiscoveredTool {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Безопасное имя тула: mcp__server__tool. */
export function sanitizeToolName(server: string, tool: string): string {
  const safeServer = server.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${safeServer}__${safeTool}`;
}

/** Привести input-схему MCP к форме дефиниций тулов. */
export function convertInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && typeof schema === "object" && "properties" in schema) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    return {
      type: "object",
      properties: schema.properties,
      required: required.length > 0 ? required : undefined,
    };
  }
  return { type: "object", properties: {} };
}

/** Промпт-блок «MCP servers available» из настроенных серверов и найденных тулов. */
export function buildMcpPromptBlock(
  serverNames: string[],
  discovered: DiscoveredTool[],
): PromptBlock | null {
  if (serverNames.length === 0) return null;

  const lines: string[] = ["---", "MCP servers available:"];

  const byServer = new Map<string, DiscoveredTool[]>();
  for (const d of discovered) {
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
    estimatedTokens: discovered.length * 20 + 20,
  };
}
