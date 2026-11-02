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

/** Поля схемы, которые считаем путями (D6: матчим только известные path-поля). */
const PATH_PROPERTY_RE =
  /^(path|paths|file|files|file_?path|filepath|file_?name|filename|dir|directory|root)$/i;

/**
 * Security-декларация MCP-тула: `manual` (сервер произволен) + `pathArgs`,
 * выведенные из input-схемы. С `pathArgs` executor тегирует вывод как
 * `file-content`, если сервер прочитал путь под `providerBlockGlobs` — иначе
 * содержимое защищённого файла уходило внешнему провайдеру как обычный текст.
 */
export function mcpToolSecurity(inputSchema: Record<string, unknown>): ToolSecurityDecl {
  const props = inputSchema?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return MCP_TOOL_SECURITY;
  const pathArgs = Object.keys(props as Record<string, unknown>).filter((key) =>
    PATH_PROPERTY_RE.test(key),
  );
  return pathArgs.length > 0 ? { ...MCP_TOOL_SECURITY, pathArgs } : MCP_TOOL_SECURITY;
}

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
