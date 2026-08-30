/**
 * Единая классификация транзиентных (временно сбойных) ошибок.
 *
 * Ранее существовало ДВЕ расходящиеся копии: `TRANSIENT_PATTERNS` в
 * stuck-detector.ts и `TRANSIENT_ERROR_PATTERNS` в moe-executor.ts. Из-за
 * этого одна и та же ошибка по-разному ретраилась в разных подсистемах:
 * moe-executor считал транзиентными 500/504/"network"/"fetch failed",
 * stuck-detector — "killed"/"SIGTERM"/"rate limit" и т.д.
 *
 * Здесь — объединение обеих копий в единый источник истины, чтобы решение
 * "эту ошибку можно ретраить" было одинаковым во всей системе.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed out/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /killed/i,
  /SIGTERM/i,
  /SIGKILL/i,
  /rate limit/i,
  /\b(429|500|502|503|504)\b/,
  /network/i,
  /fetch failed/i,
];

/** Истинно, если сообщение похоже на транзиентную (временно сбойную) ошибку. */
export function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}