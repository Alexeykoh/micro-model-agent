// Сборка кеш-статистики прогона из loop-state. Чистая функция — тестируется
// без подъёма агента; `agent.buildCacheStats` — тонкая обёртка над ней.
import type { AgentResult } from "../types";
import type { LoopState } from "./loop-state";

/**
 * Собирает статистику кеша промпта за прогон: провайдерские токены (если
 * были) плюс client-side стабильность префикса. Возвращает `undefined`, когда
 * нет ни данных провайдера, ни префикс-монитора.
 *
 * `hitRate` выставляется ТОЛЬКО при наличии провайдерских токенов: префикс-
 * монитор заполняет `stableRatio` всегда, из-за чего бэкенды без кеша раньше
 * получали `hitRate = 0` и UI показывал «0%» вместо прочерка.
 */
export function computeCacheStats(
  state: LoopState,
  saved: number | undefined,
): AgentResult["cache"] {
  const hasTokens =
    state.cacheCachedTotal > 0 || state.cacheUncachedTotal > 0 || state.cacheWriteTotal > 0;
  // Приоритет — последнему реальному разрыву, иначе состояние текущей итерации
  // (нормальная дописка / первая итерация).
  const prefix = state.lastPrefixBreak ?? state.prefixDelta;
  if (!hasTokens && prefix?.stableRatio === undefined) return undefined;
  const denom = state.cacheCachedTotal + state.cacheUncachedTotal;
  return {
    cachedTokens: state.cacheCachedTotal,
    uncachedTokens: state.cacheUncachedTotal,
    cacheWriteTokens: state.cacheWriteTotal,
    hitRate: hasTokens && denom > 0 ? state.cacheCachedTotal / denom : undefined,
    saved,
    prefixStable: prefix?.stableRatio,
    prefixCause: prefix?.cause,
    source: state.cacheSource,
  };
}
