/** Единственный расчёт бюджета системного промпта (W4). */

/** Конфигурация, достаточная для расчёта бюджета system. */
export interface SystemBudgetConfig {
  contextWindow: number;
  contextBudget: { systemPrompt: number };
}

/**
 * Бюджет system = `contextWindow × contextBudget.systemPrompt`.
 * Четыре места раньше считали его отдельно и могли разойтись; теперь одна
 * функция, общая для фазы промпта, диагностики и dry-run.
 */
export function resolveSystemBudget(config: SystemBudgetConfig): number {
  return Math.floor(config.contextWindow * config.contextBudget.systemPrompt);
}
