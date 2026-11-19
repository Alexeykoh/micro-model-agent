/** Тул метаданных текущей сессии (id, модель, бюджет контекста; alwaysOn). */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

/** Показывает сессию и загрузку контекстного бюджета. Без активной — пометка. */
export const sessionInfoTool: ToolDefinition = {
  name: "session_info",
  security: { caps: [] },
  icon: "ℹ️",
  description:
    "Show metadata about the current session: id, name, model, provider, context window, message count, and how much of the context budget is used. Use when the user asks which session this is or how much context is left.",
  alwaysOn: true,
  boundedOutput: true,
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (ctx) => {
    const meta = ctx.sessionManager?.getActiveMeta();
    if (!meta) {
      return { success: true, output: t("tool.session_info.no_active") };
    }

    const provider = ctx.config.provider;
    const providerName = provider.active ?? provider.type ?? "unknown";

    const lines = [
      t("tool.session_info.result", {
        id: meta.id,
        name: meta.name,
        model: meta.model ?? ctx.config.model ?? "unknown",
        provider: providerName,
        contextWindow: String(meta.contextWindow ?? ctx.config.contextWindow),
        messages: String(meta.messageCount),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      }),
    ];

    const snapshot = ctx.contextManager?.getSnapshot();
    if (snapshot) {
      const used = snapshot.tokens;
      const budget = snapshot.budget.history;
      const percent = budget > 0 ? Math.round((used / budget) * 100) : 0;
      lines.push(
        t("tool.session_info.context", {
          used: String(used),
          budget: String(budget),
          percent: String(percent),
        }),
      );
    }

    return { success: true, output: lines.join("\n") };
  },
};
