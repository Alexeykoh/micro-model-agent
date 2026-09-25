import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

/**
 * Build a compact system-prompt block listing the tools hidden by the current
 * tag filter. The model must know these tools exist (and how to reach them)
 * even though they are absent from the LLM tool schema. Grouped by tag with
 * short purposes; capped to keep the block small.
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

  // Group by tag → tools, then by tool name alphabetically within a tag.
  const byTag = new Map<string, ToolDefinition[]>();
  for (const tool of hidden) {
    const tags = tool.tags && tool.tags.length > 0 ? tool.tags : ["other"];
    for (const tag of tags) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(tool);
    }
  }

  const lines: string[] = [t("tools.hidden_header")];
  for (const [tag, tools] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const names = [...new Set(tools.map((tool) => tool.name))].sort().join(", ");
    lines.push(`- [${tag}] ${names}`);
  }

  return lines.join("\n");
}
