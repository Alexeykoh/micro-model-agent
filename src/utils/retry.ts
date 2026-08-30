/**
 * Экспоненциальная задержка повтора с опциональным джиттером.
 *
 * Единая реализация вместо четырёх расходящихся копий:
 * - openai-compat (стрим и fetchWithRetry): `min(base*2^attempt, max)` + jitter;
 * - moe-executor: `min(1000*2^(attempt-1), 8000)` без jitter;
 * - audit-notifier: `2^retries * 1000` без потолка.
 *
 * `maxDelay === undefined` — без потолка (копия audit-notifier).
 * `jitterFactor === 0` — без джиттера (копии moe/audit-notifier).
 */
export function backoffDelay(
  attempt: number,
  baseDelay: number,
  maxDelay?: number,
  jitterFactor = 0,
): number {
  const base =
    maxDelay !== undefined
      ? Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
      : baseDelay * Math.pow(2, attempt);
  return base + Math.random() * baseDelay * jitterFactor;
}