// Общий лимитер запросов к провайдеру на процесс.
//
// Каждый экземпляр провайдера (а значит и каждый раннер сессии) создавал свой
// лимитер — и фактический поток к провайдеру оказывался в N раз выше
// заявленного `maxRequestsPerMinute` (аудит §7.8). Один лимитер на процесс
// делает лимит честным.
import { createRateLimiter, type RateLimiter } from "../modules/security/rate-limiter";
import type { RateLimitConfig } from "../config/types";

export type { RateLimiter };

let shared: RateLimiter | undefined;

/** Общий лимитер процесса (создаётся при первом обращении). */
export function sharedRateLimiter(limits?: Partial<RateLimitConfig>): RateLimiter {
  if (!shared) shared = createRateLimiter(limits);
  return shared;
}

/** Сброс лимитера (после смены лимитов в конфиге). */
export function resetSharedRateLimiter(): void {
  shared = undefined;
}
