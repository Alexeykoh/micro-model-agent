// Типы провайдеров: записи, кеш промпта, возможности модели, ретраи и цены.
import type { ReasoningStrategy } from "./types-reasoning";

/** Как провайдер предоставляет кеширование промпта. */
export type CacheMechanism = "auto" | "explicit" | "local" | "none";

/**
 * Формат ответа, которым провайдер сообщает о попадании в кеш.
 * `openai` покрывает OpenAI, LM Studio, llama.cpp, vLLM, OpenRouter, Zen/Go и
 * Gemini/xAI — все через OpenAI-совместимую форму.
 */
export type CacheReportFormat = "openai" | "deepseek" | "anthropic" | "ollama" | "none";

/**
 * Возможность кеширования промпта у провайдера. Описывает, КАК работает кеш и
 * что клиент обязан отправить, чтобы агент адаптировался под провайдера (см.
 * docs/specs/2026-09-17-prompt-caching-budget.md). Запросные флаги по
 * умолчанию false: включение — опция, потому что часть бэкендов (llama.cpp
 * `cache_prompt`) обменивает детерминизм на переиспользование.
 */
export interface CacheCapability {
  mechanism: CacheMechanism;
  report: CacheReportFormat;
  /** Слать `x-opencode-session` для кеш/sticky-маршрутизации (OpenCode Zen/Go). */
  sessionHeader: boolean;
  /** Слать `cache_prompt: true` в теле (llama.cpp). */
  requestCachePrompt: boolean;
  /** Слать `prompt_cache_key` в теле (OpenAI). */
  requestPromptCacheKey: boolean;
  /** Слать `session_id` в теле для sticky-маршрутизации (OpenRouter). */
  requestSessionId: boolean;
  /** Помечать блоки контента `cache_control` (Anthropic). */
  requestCacheControl: boolean;
  /**
   * Слать `stream_options: { include_usage: true }` в стриминге, чтобы бэкенд
   * вернул финальный usage-чанк (иначе многие OpenAI-совместимые серверы,
   * включая LM Studio, не отдают usage/`cached_tokens` в стриме).
   */
  requestStreamUsage: boolean;
}

/**
 * Возможности конкретной модели, уточняющие пресет провайдера. Единый
 * источник правды для тулов; поля необязательны, приоритет — `resolveModelCapabilities`.
 */
export interface ModelCapabilities {
  /** Модель принимает изображения (image парты в сообщениях). */
  vision?: boolean;
  /** Модель умеет вызывать инструменты. */
  tools?: boolean;
  /** Механизм reasoning (INV-R2): 3 слоя, как vision/tools — оверрайд → проба → пресет. */
  reasoningStrategy?: ReasoningStrategy;
  /** Эндпоинт умеет выключать reasoning (native `reasoning.allowed_options` ∋ off). */
  reasoningOff?: boolean;
  /** Объявленные эндпоинтом значения `reasoning_effort` (INV-R7). */
  reasoningLevels?: string[];
}

/** Одна настроенная запись провайдера (из возможных многих). */
export interface ProviderEntry {
  /** Тип из реестра: "openai-compat" | "openrouter" | "openai" | "opencode-zen" | ... */
  type: string;
  /** Имя для пользователя (пустое = тип). */
  label?: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  retry?: RetryConfig;
  rateLimits?: Partial<RateLimitConfig>;
  /** Потолок completion-токенов, шлётся как max_tokens (дефолт 8192). Подними для
   *  reasoning-моделей, режущих аргументы tool_call. */
  maxCompletionTokens?: number;
  /** Порядок фолбэка (меньше = пробуется раньше). */
  priority?: number;
  /** Переопределения кеша для записи, накладываются на пресет провайдера. */
  cache?: Partial<CacheCapability>;
}

export interface ProviderConfig {
  /**
   * Имя/лейбл активного провайдера (совпадает с `ProviderEntry.label` или
   * `.type`). Без `entries` — legacy-конфиг одного провайдера, действуют
   * `type`/`baseUrl`/`apiKey`.
   */
  active?: string;
  /** Все настроенные провайдеры (мультирежим). */
  entries?: ProviderEntry[];
  /**
   * Последняя модель каждого провайдера (имя — `label` или `type`). Пишется при
   * каждой смене активной модели, чтобы переключение провайдеров возвращало
   * каждому его модель.
   */
  models?: Record<string, string>;
  /** Автофейловер на следующий провайдер при 429/5xx (дефолт false). */
  fallback?: boolean;
  /**
   * Staged rollout (Evals 2/2): при percentage > 0 потоки с бакетом < percentage
   * (`inRollout(threadId)`) переключаются на запись `candidate` уже при старте
   * сессии. `candidate` обязан существовать в entries; нет кандидата — игнор.
   */
  rollout?: { candidate?: string; percentage?: number };
  // Legacy-плоские поля одного провайдера — продолжают работать (зеркалят активную запись).
  type: string;
  baseUrl: string;
  apiKey?: string;
  /** Legacy-плоский потолок completion (зеркалится в нормализованную запись). */
  maxCompletionTokens?: number;
}

/** Цена модели в USD за 1M токенов. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Цена чтения из кеша (cache read). По умолчанию равна input. */
  cachedInput?: number;
  /** Цена записи в кеш (cache write). По умолчанию 0 (бесплатно). */
  cacheWrite?: number;
}

/**
 * Тарифы / трекинг стоимости. `overrides` — ручные цены по моделям (USD за 1M
 * токенов); `builtin` покрывает известных провайдеров (OpenCode Zen / Go).
 * Нет цены — стоимость не показывается.
 */
export interface PricingConfig {
  /** Мастер-выключатель трекинга и показа стоимости. */
  enabled: boolean;
  /** Пользовательские цены по моделям (id модели -> {input, output}). */
  overrides: Record<string, ModelPrice>;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  /** Доп. ретраи, если стрим ответа рвётся ДО выдачи любого контента. */
  maxStreamRetries?: number;
  /** Макс. тишина (мс) между чанками стрима — дальше соединение считается мёртвым. */
  noDataTimeoutMs?: number;
}

export interface RateLimitConfig {
  maxRequestsPerMinute: number;
  maxParallelTasks: number;
}
