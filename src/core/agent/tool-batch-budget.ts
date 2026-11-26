/** BCP-3: мягкий бюджет вызовов тулов на ход. */
import type { LoopState } from "./loop-state";
import { SOFT_TOOL_BUDGET, SOFT_TOOL_BUDGET_RATIO } from "./constants";

/**
 * Эффективный мягкий бюджет для текущей конфигурации хода.
 *
 * Нижняя граница — исторические 16 вызовов (защита от тривиальных задач,
 * ушедших в 18 тулов). Верхняя — доля от жёсткого `maxToolIterations`: при
 * лимите 200 модель получает 150 вызовов вместо 16 и может довести задачу до
 * конца за один ход. Никогда не превышает сам hard cap.
 */
export function effectiveSoftToolBudget(maxToolIterations: number): number {
  if (!Number.isFinite(maxToolIterations) || maxToolIterations <= 0) return SOFT_TOOL_BUDGET;
  const scaled = Math.floor(maxToolIterations * SOFT_TOOL_BUDGET_RATIO);
  return Math.max(SOFT_TOOL_BUDGET, Math.min(scaled, maxToolIterations));
}

export function softBudgetDue(state: LoopState): boolean {
  return state.toolCallsThisTurn >= state.softToolBudget;
}
