/** Фильтр тулов по тегам; `alwaysOn` сохраняются всегда. */
import type { ToolDefinition } from "./types";

/**
 * Фильтрует тулы по набору тегов, всегда оставляя `alwaysOn`. Для tool_tags
 * эксперта и subagent — структурные тулы (plan/todo/verify,
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

/**
 * Tag-фильтр с ручными per-session переопределениями (`mma web` → Tools).
 * `disabled` убирает имя даже из `alwaysOn`; `enabled` добавляет имя, даже если
 * его тег не активен. Поле `toolOverrides` не ослабляет security-allowlist —
 * его проверяет вызывающий до/после (executor).
 */
export function filterToolsWithOverrides(
  tools: ToolDefinition[],
  toolTags: string[],
  overrides?: { enabled?: string[]; disabled?: string[] },
): ToolDefinition[] {
  const base = new Set(filterToolsByTags(tools, toolTags).map((t) => t.name));
  const enabled = new Set(overrides?.enabled ?? []);
  const disabled = new Set(overrides?.disabled ?? []);
  return tools.filter((t) => {
    if (disabled.has(t.name)) return false;
    if (enabled.has(t.name)) return true;
    return base.has(t.name);
  });
}
