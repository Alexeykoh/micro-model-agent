/** Лимиты параметра `max_tokens` тула `subagent` (вынесено из `subagent-run.ts`). */

/** Минимальный кап completion-токенов субагента. */
export const MAX_TOKENS_MIN = 1;
/** Максимальный кап completion-токенов субагента. */
export const MAX_TOKENS_MAX = 32000;

/**
 * Разбирает `max_tokens`: число в диапазоне — кап, `undefined` — без капа,
 * `"invalid"` — значение задано, но недопустимо.
 */
export function parseMaxTokens(raw: unknown): number | undefined | "invalid" {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MAX_TOKENS_MIN || value > MAX_TOKENS_MAX) {
    return "invalid";
  }
  return Math.floor(value);
}
