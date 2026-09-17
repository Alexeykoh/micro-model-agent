import { t } from "../i18n/index";
import { formatCost } from "../modules/pricing/prices";

/** Кеш-сводка прогона для футера CLI/REPL. */
export interface CacheReport {
  cachedTokens: number;
  uncachedTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  saved?: number;
  prefixStable?: number;
  prefixCause?: string;
  source: string;
}

/**
 * Формирует строку кеша для футера. Возвращает undefined, когда показывать
 * нечего: провайдер не отдал cache-токены и префикс не ломался. Так вывод не
 * засоряется на бэкендах без кеша.
 */
export function formatCacheLine(cache?: CacheReport): string | undefined {
  if (!cache) return undefined;
  const total = cache.cachedTokens + cache.uncachedTokens;
  const hit = Math.round(cache.hitRate * 100);

  if (total > 0) {
    if (cache.saved !== undefined && cache.saved > 0) {
      return t("repl.cache", { hit, saved: formatCost(cache.saved) });
    }
    return t("repl.cache_nosave", { hit });
  }

  // Нет провайдерских токенов — показываем только сломанный префикс.
  if (cache.prefixStable !== undefined && cache.prefixStable < 0.98) {
    const stable = Math.round(cache.prefixStable * 100);
    const causeKey = `cache.cause.${cache.prefixCause ?? "unknown"}`;
    return t("repl.prefix", { stable, cause: t(causeKey) });
  }
  return undefined;
}
