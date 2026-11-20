/** BCP-3: мягкий бюджет вызовов тулов на ход. */
import type { LoopState } from "./loop-state";
import { SOFT_TOOL_BUDGET } from "./constants";

export function softBudgetDue(state: LoopState): boolean {
  return state.toolCallsThisTurn >= SOFT_TOOL_BUDGET;
}
