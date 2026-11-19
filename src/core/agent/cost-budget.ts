// Per-run бюджет стоимости (Cost/LLM-gateway MVP).
/** true, если лимит включён и текущий расход прогона его достиг/превысил. */
export function costBudgetExceeded(usedUsd: number, maxRunUsd: number): boolean {
  return maxRunUsd > 0 && usedUsd >= maxRunUsd;
}
