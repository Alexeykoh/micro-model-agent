// Промпт-поверхность плана: блок системного промпта и строка сводки компакции.
// Вынесено из `plan-session.ts` (правило 6); тексты и приоритеты не менялись.
import { t } from "../../i18n/index";
import type { PromptBlock } from "../../core/types";
import type { PlanTracker } from "./tracker";

/** Блок системного промпта с чеклистом плана (null без активного/незавершённого). */
export function planPromptBlock(tracker: PlanTracker | null): PromptBlock | null {
  if (!tracker || tracker.isComplete()) return null;
  return {
    content: tracker.toPromptBlock(),
    priority: "critical",
    essential: true,
    estimatedTokens: 200,
    // Меняется на каждом plan_step — в хвост, чтобы не рвать prefix-cache.
    tail: true,
  };
}

/**
 * Короткая строка "текущий план" для сводки компакции. Null без активного
 * плана. Для 9B-моделей важна явная инструкция "continue it, do NOT create
 * a new plan" — после компакции блок плана виден, но модель всё равно
 * пересоздаёт план. Готовый план в сводке — "план done, можно новый", а НЕ
 * "continue step 4, do NOT create a new plan", якоривший петлю.
 */
export function planSummary(tracker: PlanTracker | null): string | null {
  if (!tracker) return null;
  const plan = tracker.getPlan();
  const done = plan.steps.filter((s) => s.status === "done").length;
  const total = plan.steps.length;
  if (tracker.isComplete()) {
    return t("exec.plan_summary_complete", {
      id: plan.id,
      title: plan.title,
      done: String(done),
      total: String(total),
    });
  }
  const current = tracker.getCurrentStepIndex() + 1;
  return t("exec.plan_summary_continue", {
    id: plan.id,
    title: plan.title,
    done: String(done),
    total: String(total),
    current: String(current),
  });
}
