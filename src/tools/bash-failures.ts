/**
 * Счётчики подряд-падений bash-команд по первому слову (Windows-хинты и
 * жёсткий стоп). Вынесено из `bash.ts` (правило 6).
 */

/**
 * Падения по первому слову (сброс при успехе): после HARD_BLOCK_THRESHOLD — STOP.
 * Счётчики на контекст прогона (WeakMap), не на процесс: иначе падения
 * субагента копились в счётчике родителя (A5).
 */
export const HARD_BLOCK_THRESHOLD = 3;

let FAILING_FIRST_WORDS = new WeakMap<object, Map<string, number>>();

/** Счётчик падений текущего прогона (контекста вызова). */
export function failureCounters(ctx: unknown): Map<string, number> {
  const key = (ctx ?? {}) as object;
  let counters = FAILING_FIRST_WORDS.get(key);
  if (!counters) FAILING_FIRST_WORDS.set(key, (counters = new Map()));
  return counters;
}

/** Тестовый хук: сбросить счётчики подряд-падений. */
export function resetBashFailureTracking(): void {
  FAILING_FIRST_WORDS = new WeakMap();
}
