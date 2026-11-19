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

/**
 * Порог подряд идущих «шелл недоступен»: с этого вызова bash не спавнит —
 * повторный спавн заведомо падает, итерации жалеть нечем (S1).
 */
export const SHELL_STOP_THRESHOLD = 3;

let FAILING_FIRST_WORDS = new WeakMap<object, Map<string, number>>();

/** Счётчик падений текущего прогона (контекста вызова). */
export function failureCounters(ctx: unknown): Map<string, number> {
  const key = (ctx ?? {}) as object;
  let counters = FAILING_FIRST_WORDS.get(key);
  if (!counters) FAILING_FIRST_WORDS.set(key, (counters = new Map()));
  return counters;
}

let SHELL_UNAVAILABLE = new WeakMap<object, number>();

/** Сколько раз подряд шелл был недоступен (по классификатору S1). */
export function shellUnavailableStreak(ctx: unknown): number {
  return SHELL_UNAVAILABLE.get((ctx ?? {}) as object) ?? 0;
}

/** Отметить очередное «шелл недоступен»; возвращает новое значение. */
export function recordShellUnavailable(ctx: unknown): number {
  const key = (ctx ?? {}) as object;
  const next = (SHELL_UNAVAILABLE.get(key) ?? 0) + 1;
  SHELL_UNAVAILABLE.set(key, next);
  return next;
}

/** Сброс по успешному bash: шелл снова работает. */
export function resetShellUnavailable(ctx: unknown): void {
  SHELL_UNAVAILABLE.delete((ctx ?? {}) as object);
}

/** Тестовый хук: сбросить счётчики подряд-падений. */
export function resetBashFailureTracking(): void {
  FAILING_FIRST_WORDS = new WeakMap();
  SHELL_UNAVAILABLE = new WeakMap();
}
