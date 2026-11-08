/** Тело запроса к OpenAI-совместимому API: сборка и нормализация reasoning.
 *
 * Вынесено из `openai-compat.ts` (правило 6: ≤300 строк). Здесь только форма
 * тела — сеть, ретраи и стрим остаются у провайдера. Кап `max_tokens` и
 * подсказки кеша приходят готовыми: эта функция не читает конфиг.
 */
import type { ToolDefinition } from "./provider";
import type { ReasoningStrategy } from "../config/types";

/** Ранг канонических уровней для проекции на объявленные эндпоинтом (INV-R7). */
const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** Ближайший поддерживаемый уровень: не ниже запрошенного, иначе высший. */
export function projectLevel(level: string, supported: string[]): string {
  if (supported.includes(level)) return level;
  const alias = level === "max" ? "high" : level;
  if (supported.includes(alias)) return alias;
  const target = EFFORT_RANK[level] ?? -1;
  let highest = supported[0];
  let highestRank = Number.NEGATIVE_INFINITY;
  let above: string | undefined;
  let aboveRank = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const rank = EFFORT_RANK[candidate];
    if (rank === undefined) continue;
    if (rank >= target && rank < aboveRank) {
      above = candidate;
      aboveRank = rank;
    }
    if (rank > highestRank) {
      highest = candidate;
      highestRank = rank;
    }
  }
  return above ?? highest;
}

/** Уровень под контракт `reasoning_effort`: "default" не шлём,
 *  "none" — только при объявленном выключателе и механизме-поле (strict 400),
 *  остальные проецируются на объявленные эндпоинтом уровни (INV-R7). */
export function normalizeReasoningEffort(
  level: string | undefined,
  strategy: ReasoningStrategy,
  reasoningOff: boolean,
  reasoningLevels?: string[],
): string | undefined {
  if (!level || level === "default") return undefined;
  if (level === "none") {
    return reasoningOff && strategy === "openai-effort" ? "none" : undefined;
  }
  if (reasoningLevels) {
    if (reasoningLevels.length === 0) return undefined; // declared but no granular levels
    return projectLevel(level, reasoningLevels);
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
  /** Объявленные эндпоинтом значения effort (INV-R7). */
  reasoningLevels?: string[];
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
  const effort = normalizeReasoningEffort(
    opts.reasoningEffort,
    strategy,
    opts.reasoningOff === true,
    opts.reasoningLevels,
  );

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
