/** Фильтр тулов по тегам; `alwaysOn` сохраняются всегда. */
import type { ToolDefinition } from "./types";

/**
 * Фильтрует тулы по набору тегов, всегда оставляя `alwaysOn`. Для MoE-роутинга
 * экспертов и subagent tool_tags — структурные тулы (plan/todo/verify,
 * project_map, lsp_check, enable_tools) переживают сужение.
 */
export function filterToolsByTags(tools: ToolDefinition[], toolTags: string[]): ToolDefinition[] {
  if (!toolTags || toolTags.length === 0) return tools;
  const tagSet = new Set(toolTags);
  return tools.filter((t) => {
    if (t.alwaysOn) return true;
    if (!t.tags || t.tags.length === 0) return false;
    return t.tags.some((tag) => tagSet.has(tag));
  });
}
