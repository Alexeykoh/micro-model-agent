/**
 * Гейт собственного rate-limit провайдера перед запросом: ограниченное
 * ожидание слота и recoverable-ошибка, если он не освободился. Вынесено из
 * `openai-compat.chat` (правило 6).
 */
import type { RateLimiter } from "../modules/security/rate-limiter";
import { LlmError } from "./llm-errors";
import { LLM_MAX_RATE_WAIT_MS as MAX_RATE_WAIT_MS } from "../config/timeouts";

/**
 * Проверка лимита до запроса. Собственный лимит ждёт слота (ограниченно),
 * а не роняет здоровый ход; recoverable-ошибка наружу — только если слот
 * не освободился в окне (цикл скормит её модели, а не умрёт).
 */
export async function waitForRateLimit(
  limiter: RateLimiter,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!limiter.canMakeRequest()) {
    const waitMs = Math.min(limiter.msUntilRequest(), MAX_RATE_WAIT_MS);
    if (waitMs > 0) {
      await sleep(waitMs, signal);
    }
    if (!limiter.canMakeRequest()) {
      throw new LlmError(
        `Rate limit exceeded: ${limiter.getConfig().maxRequestsPerMinute} requests per minute`,
        { recoverable: true },
      );
    }
  }

  // Фиксируем запрос
  limiter.recordRequest();
}
