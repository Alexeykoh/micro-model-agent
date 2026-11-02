/** Тело запроса к OpenAI-совместимому API: сборка и нормализация reasoning.
 *
 * Вынесено из `openai-compat.ts` (правило 6: ≤300 строк). Здесь только форма
 * тела — сеть, ретраи и стрим остаются у провайдера. Кап `max_tokens` и
 * подсказки кеша приходят готовыми: эта функция не читает конфиг.
 */
import type { ToolDefinition } from "./provider";
import type { ReasoningStrategy } from "../config/types";

/** Уровень под контракт `reasoning_effort`: "default" не шлём, "max"→"high",
 *  "none" — только при объявленном выключателе и механизме-поле (strict 400). */
export function normalizeReasoningEffort(
  level: string | undefined,
  strategy: ReasoningStrategy,
  reasoningOff: boolean,
): string | undefined {
  if (!level || level === "default") return undefined;
  if (level === "none") {
    return reasoningOff && strategy === "openai-effort" ? "none" : undefined;
  }
  if (level === "max") return "high";
  return level;
}

/** Параметры сборки тела запроса. */
export interface RequestBodyOptions {
  model: string;
  messages: unknown[];
  tools?: ToolDefinition[];
  stream: boolean;
  maxTokens?: number;
  reasoningEffort?: string;
  reasoningStrategy?: ReasoningStrategy;
  reasoningOff?: boolean;
  /** Подсказки кеша (llama.cpp `cache_prompt`). */
  cachePrompt?: boolean;
  /** Ключ кеша для OpenAI (`prompt_cache_key`). */
  promptCacheKey?: string;
  /** Идентификатор для sticky-маршрутизации OpenRouter (`session_id`). */
  sessionId?: string;
  /** Запросить финальный usage-чанк в стриме (`stream_options.include_usage`). */
  streamUsage?: boolean;
}

/** Собрать тело POST `/chat/completions`. */
export function buildRequestBody(opts: RequestBodyOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: opts.stream,
  };
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.cachePrompt) body.cache_prompt = true;
  if (opts.promptCacheKey) body.prompt_cache_key = opts.promptCacheKey;
  if (opts.sessionId) body.session_id = opts.sessionId;
  if (opts.stream && opts.streamUsage) body.stream_options = { include_usage: true };

  // Применяем effort через стратегию провайдера (уровень нормализуется под
  // контракт OpenAI: low|medium|high).
  const strategy = opts.reasoningStrategy ?? "openai-effort";
  const effort = normalizeReasoningEffort(opts.reasoningEffort, strategy, opts.reasoningOff === true);

  if (strategy === "openai-effort") {
    if (effort) body.reasoning_effort = effort;
  } else if (strategy === "template-kwarg") {
    body.chat_template_kwargs = { enable_thinking: opts.reasoningEffort !== "none" };
  } else if (strategy === "prompt-tag") {
    // Шлём reasoning_effort в теле (модели с API-поддержкой) И тег /no_think
    // в сообщение (модели только с prompt-сигналами; тег ставит `chat()`).
    if (effort) body.reasoning_effort = effort;
  }
  // "none" = не поддерживается, пропуск

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body.tool_choice = "auto";
  }
  return body;
}
