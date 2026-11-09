/**
 * Тул явного Yes/No-подтверждения действия (интерактивный, alwaysOn).
 *
 * С `path` подтверждение авторитетно: по Yes хендлер минтит одноразовое
 * разрешение в `ctx.approvals`, и enforcement (`checkToolPath`) пропускает одну
 * запись в защищённый путь. Без `path` — прежнее поведение (просто Yes/No).
 * Долг `approve-marker-not-authoritative` закрыт: текст ответа модели не читается.
 */
import { t } from "../i18n/index";
import { safeResolvePath } from "./path-utils";
import { askChoice } from "./user-input";
import { shouldEscalate, type Impact } from "../modules/hitl/escalation";
import type { ToolDefinition } from "./types";

/** Просит подтверждение; reject — success:false (сигнал сбоя для цикла). */
export const approveTool: ToolDefinition = {
  name: "approve",
  security: { caps: [{ interactive: true }] },
  icon: "🙋",
  description:
    "Request user approval for an action. The user picks Yes or No from a menu. Pass `path` " +
    "to authorize exactly one write to that protected file.",
  tags: ["core"],
  // Как в question.ts: интерактивные тулы переживают сужение (P5).
  alwaysOn: true,
  interactive: true,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Description of the action requiring approval",
      },
      path: {
        type: "string",
        description: t("tool.approve_path_desc"),
      },
      impact: {
        type: "string",
        enum: ["low", "medium", "high", "critical"],
        description: "Impact of the action. low = auto-approvable when hitl.autoApproveLow.",
      },
    },
    required: ["action"],
  },
  handler: async (ctx, args) => {
    if (ctx.exitOnComplete) {
      return { success: false, output: t("tool.interactive_disabled") };
    }
    const action = String(args.action || "");
    const rawPath = String(args.path || "").trim();
    const impact = args.impact as Impact | undefined;
    // Escalation: low impact auto-approves only when policy allows.
    if (!shouldEscalate(impact, ctx.config?.hitl)) {
      return { success: true, output: t("tool.approved") };
    }
    const question = t("tool.approve_prompt", { action });
    const options = [
      { label: t("tool.approve_yes"), description: t("tool.approve_yes_desc") },
      { label: t("tool.approve_no"), description: t("tool.approve_no_desc") },
    ];
    const indexes = ctx.promptIO
      ? await ctx.promptIO.askChoice(question, options, { allowCustom: false })
      : await askChoice(question, options);
    if (indexes[0] !== 0) return { success: false, output: t("tool.rejected") };
    if (!rawPath) return { success: true, output: t("tool.approved") };
    // Абсолютный путь — тот же, что увидит enforcement (safeResolvePath).
    ctx.approvals?.grant(safeResolvePath(ctx.baseDir, rawPath), action);
    return { success: true, output: t("tool.approved_path", { path: rawPath }) };
  },
};
