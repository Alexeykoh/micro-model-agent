import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

/**
 * On-demand tool activation. The main loop exposes only `config.tools.defaultTags`
 * (+ `alwaysOn` structural tools). Specialized tools (web, browser, memory,
 * process) are hidden from the schema to shrink the token footprint; the model
 * activates them by calling this tool with the desired tag. The handler pushes
 * the tags into the shared mutable `ctx.activeToolTags` array, which the agent
 * loop re-reads each iteration to recompute the LLM-visible tool set.
 */
export const enableToolsTool: ToolDefinition = {
  name: "enable_tools",
  icon: "🔌",
  description:
    "Enable hidden tool categories for the current session. Only the essential tools (file/code/shell) are active by default. Call this with the tags you need and they become available from the next turn. Available tags: file, code, shell, research, browser, vision, image, memory, core. Returns the newly available tools. To run a task in a separate context instead, use subagent with tool_tags.",
  alwaysOn: true,
  parameters: {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          'Tool tags to enable (e.g. ["research"] for web_search/web_fetch, ["browser"] for the browser, ["memory"] for remember/recall, ["shell"] for process management).',
      },
    },
    required: ["tags"],
  },
  handler: async (ctx, args) => {
    const requested = Array.isArray(args.tags) ? args.tags.map(String).filter(Boolean) : [];
    if (requested.length === 0) {
      return { success: false, output: t("tools.enable_no_tags") };
    }

    const active = ctx.activeToolTags ?? [];
    const added: string[] = [];
    for (const tag of requested) {
      if (!active.includes(tag)) {
        active.push(tag);
        added.push(tag);
      }
    }

    if (!ctx.toolExecutor) {
      return { success: false, output: t("tools.enable_no_executor") };
    }
    const nowVisible = ctx.toolExecutor.getToolDefinitions([...active]).map((t) => t.name);

    if (added.length === 0) {
      return {
        success: true,
        output: t("tools.enable_already_active", {
          tags: requested.join(", "),
        }),
      };
    }

    return {
      success: true,
      output: t("tools.enable_added", {
        tags: added.join(", "),
        tools: nowVisible.join(", "),
      }),
    };
  },
};
