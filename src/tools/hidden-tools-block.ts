/** Блок системного промпта о скрытых tag-фильтром тулах. */
import type { ToolDefinition } from "./types";

/** Модельный заголовок — английский, без локали пользователя. */
const HIDDEN_TOOLS_HEADER =
  "Additional tools (enable on demand via enable_tools or route to subagent tool_tags):";

/**
 * Компактный блок системного промпта со скрытыми тулами. Модель должна знать
 * об их существовании (и пути доступа), хотя их нет в tool-схеме LLM.
 * Группировка по тегам, размер ограничен.
 */
export function buildHiddenToolsBlock(allTools: ToolDefinition[], activeTags: string[]): string {
  if (!allTools.length) return "";

  const activeSet = new Set(activeTags);
  const visible = new Set<string>();
  for (const tool of allTools) {
    if (tool.alwaysOn || (tool.tags?.some((tag) => activeSet.has(tag)))) {
      visible.add(tool.name);
    }
  }

  const hidden = allTools.filter((tool) => !visible.has(tool.name));
  if (hidden.length === 0) return "";

  // Группировка по тегам, внутри тега — по имени тула.
  const byTag = new Map<string, ToolDefinition[]>();
  for (const tool of hidden) {
    const tags = tool.tags && tool.tags.length > 0 ? tool.tags : ["other"];
    for (const tag of tags) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(tool);
    }
  }

  const lines: string[] = [HIDDEN_TOOLS_HEADER];
  for (const [tag, tools] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const names = [...new Set(tools.map((tool) => tool.name))].sort().join(", ");
    lines.push(`- [${tag}] ${names}`);
  }

  return lines.join("\n");
}
