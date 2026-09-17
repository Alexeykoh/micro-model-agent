// src/modules/providers/cache.ts
import type { CacheCapability } from "../../config/types";
import type { ProviderSpec } from "./types";

/**
 * Фолбэк для провайдеров без кеша и без полей запроса о кеше. Используется,
 * когда пресет не объявляет `cache`-возможность.
 */
export const NO_CACHE_CAPABILITY: CacheCapability = {
  mechanism: "none",
  report: "none",
  sessionHeader: false,
  requestCachePrompt: false,
  requestPromptCacheKey: false,
  requestSessionId: false,
  requestCacheControl: false,
  requestStreamUsage: false,
};

/**
 * Резолвит эффективную cache-возможность провайдера: дефолт пресета, поверх
 * которого накладывается переопределение из записи конфига. Всегда возвращает
 * новый объект, чтобы вызывающий не рисковал мутировать общее состояние.
 */
export function resolveCacheCapability(
  spec: ProviderSpec | undefined,
  override?: Partial<CacheCapability>,
): CacheCapability {
  const base = spec?.capabilities.cache ?? NO_CACHE_CAPABILITY;
  return { ...base, ...(override ?? {}) };
}
