/**
 * Рендер thin-REPL для plan/usage (split W8): те же данные, что видит web,
 * но строкой в терминал. Вынесено для юнит-тестов без редактора.
 */
import { t } from "../i18n/index";
import { formatCost } from "../modules/pricing/prices";

/** Строки шага плана: номер, статус и текст. */
export function planLines(data: Record<string, unknown>): string[] {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const marks: Record<string, string> = {
    pending: "○",
    in_progress: "◐",
    done: "●",
    failed: "✗",
  };
  return steps.map((raw, i) => {
    const step = (raw ?? {}) as { text?: unknown; status?: unknown };
    const status = String(step.status ?? "pending");
    return `${i + 1}. ${marks[status] ?? "·"} ${String(step.text ?? "")}`;
  });
}

/** Итог хода: стоимость, иначе суммарные токены; нет usage — `undefined`. */
export function usageLine(data: Record<string, unknown>): string | undefined {
  const usage = data.usage as
    { promptTokens?: number; completionTokens?: number; costUsd?: number } | undefined;
  if (!usage) return undefined;
  if (typeof usage.costUsd === "number" && usage.costUsd > 0) {
    return t("repl.cost", { cost: formatCost(usage.costUsd) });
  }
  const total = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  return total > 0 ? t("repl.tokens", { tokens: String(total) }) : undefined;
}
