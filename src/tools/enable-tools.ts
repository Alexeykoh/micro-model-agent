/** On-demand тул: включает скрытые категории тулов на сессию. */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

/**
 * On-demand активация тулов. Главный цикл показывает только
 * `config.tools.defaultTags` (+ структурные `alwaysOn`); спецтулы (web,
 * browser, memory, process) скрыты из схемы ради экономии токенов. Модель
 * включает их этим тулом; хендлер дописывает теги в общий мутабельный
 * `ctx.activeToolTags`, который цикл перечитывает каждую итерацию.
 */
export const enableToolsTool: ToolDefinition = {
  name: "enable_tools",
  security: { caps: [] },
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
