/**
 * Конфигурация OpenAI-совместимого провайдера. Вынесено из `openai-compat.ts`
 * (правило 6), чтобы запросы/стрим не зависели от класса.
 */
import type {
  CacheCapability,
  RateLimitConfig,
  ReasoningStrategy,
} from "../config/types";
import type { RateLimiter } from "../modules/security/rate-limiter";

/** Конфиг ретраев: попытки, задержки, ретраи оборванного стрима, тишина. */
export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  /** Доп. ретраи, если стрим рвётся ДО любого контента. */
  maxStreamRetries?: number;
  /** Макс. тишина (мс) между чанками — дальше соединение считается мёртвым. */
  noDataTimeoutMs?: number;
}

/** Cap completion-токенов в max_tokens, если конфиг не задал. */
export const DEFAULT_MAX_COMPLETION_TOKENS = 8192;

/** Конфиг провайдера: модель, URL, ключ, окно, ретраи, кеш, логгер. */
export interface OpenAICompatConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  maxCompletionTokens?: number;
  retry?: RetryConfig;
  rateLimits?: Partial<RateLimitConfig>;
  /** Общий лимитер запросов на процесс (иначе у каждого экземпляра свой). */
  rateLimiter?: RateLimiter;  /** Живой id диалога → `x-opencode-session` (требует OpenCode Go) + кеш-аффинити. */
  getSessionId?: () => string | undefined;
  /** Cache-возможность: подсказки кеша и гейтинг `x-opencode-session`; нет = легаси. */
  cache?: CacheCapability;
  /** Переопределение User-Agent (дефолт `micro-models-agent/<version>`). */
  userAgent?: string;
  /** Механизм reasoning (INV-R1): резолвится при сборке; отсутствие = `openai-effort`. */
  reasoningStrategy?: ReasoningStrategy;
  /** Эндпоинт умеет выключать reasoning (`reasoning_effort: "none"` легитимен). */
  reasoningOff?: boolean;
  logger?: import("../logger/app-logger").Logger;
}
