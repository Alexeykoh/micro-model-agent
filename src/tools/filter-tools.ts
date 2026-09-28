import type { ToolDefinition } from "./types";

/**
 * Filter tools by a tag set, always keeping `alwaysOn` tools. Used by MoE
 * expert routing and subagent tool_tags so structural tools (plan/plan_step/
 * todo/verify, project_map, lsp_check, enable_tools) survive narrowing.
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
