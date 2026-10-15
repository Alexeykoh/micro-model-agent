// Типы провайдеров: capabilities, опции фабрики, спек регистрации.
// src/modules/providers/types.ts
import type { LLMProvider } from "../../llm/provider";
import type { RetryConfig } from "../../config/types";
import type { RateLimitConfig } from "../../config/types";
import type { ReasoningStrategy } from "../../config/types";
import type { CacheCapability } from "../../config/types";

/**
 * Что провайдер заявляет как поддерживаемое. Петля агента адаптируется по ним
 * (напр. не шлёт `reasoning_effort` бэкендам, которые его отвергают, отказывает
 * модели без настроенного `apiKey` и т.п.).
 */
export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  /** Как провайдер выражает reasoning effort. */
  reasoningStrategy: ReasoningStrategy;
  /** Эндпоинт умеет выключать reasoning (`reasoning_effort: "none"` легитимен). */
  reasoningOff?: boolean;
  listModels: boolean;
  requiresKey: boolean;
  auth?: "bearer" | "header";
  /** Поведение кеша промпта; отсутствует = "none" (нет отчёта и подсказок запроса). */
  cache?: CacheCapability;
}

/** Опции, передаваемые фабрике провайдера. */
export interface ProviderOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow: number;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  /** Per-call кап completion (max_tokens). В openai-compat дефолт 8192. */
  maxCompletionTokens?: number;
  capabilities?: Partial<ProviderCapabilities>;
  /** Живой id беседы, шлётся как `x-opencode-session`, если задан. */
  getSessionId?: () => string | undefined;
  /** Опциональный логгер диагностики LLM-запросов/ответов. */
  logger?: import("../../logger/app-logger").Logger;
}

/** Зарегистрированный провайдер: метаданные + фабрика LLMProvider. */
export interface ProviderSpec {
  type: string;
  label: string;
  /** Дефолтный base URL пресета. Пустая строка = вводит пользователь. */
  baseUrl: string;
  capabilities: ProviderCapabilities;
  create: (opts: ProviderOptions) => LLMProvider;
}