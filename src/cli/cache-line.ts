// Строка кеша в футере: хитрейт, экономия, стабильность префикса.
import { t } from "../i18n/index";
import { formatCost } from "../modules/pricing/prices";

/** Кеш-сводка прогона для футера CLI/REPL. */
export interface CacheReport {
  cachedTokens: number;
  uncachedTokens: number;
  cacheWriteTokens: number;
  /** cached / (cached + uncached); отсутствует, когда провайдер не отдал токены. */
  hitRate?: number;
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

  if (total > 0) {
    const hit = Math.round((cache.hitRate ?? 0) * 100);
    if (cache.saved !== undefined && cache.saved > 0) {
      return t("repl.cache", { hit, saved: formatCost(cache.saved) });
    }
    return t("repl.cache_nosave", { hit });
  }

  // Нет провайдерских токенов — показываем только РЕАЛЬНЫЙ разрыв префикса.
  // `none` (нормальная дописка истории) и `unknown` (нет предыдущего промпта —
  // первая итерация) не являются промахом и не должны пугать.
  const broken =
    cache.prefixCause !== undefined &&
    cache.prefixCause !== "none" &&
    cache.prefixCause !== "unknown";
  if (broken && cache.prefixStable !== undefined && cache.prefixStable < 0.98) {
    const stable = Math.round(cache.prefixStable * 100);
    return t("repl.prefix", { stable, cause: t(`cache.cause.${cache.prefixCause}`) });
  }
  return undefined;
}
