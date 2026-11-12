/** OpenAI-совместимый провайдер: стрим/SSE, ретраи, reasoning, кеш-хинты. */
import type { LLMProvider, Message, Chunk, ToolDefinition, ChatOptions } from "./provider";
import { TokenCounter } from "./token-counter";
import { type RateLimiter, createRateLimiter } from "../modules/security/rate-limiter";
import type { CacheCapability, CacheReportFormat, ReasoningStrategy } from "../config/types";
import { buildRequestBody } from "./request-body";
import { LLM_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS } from "../config/timeouts";
import {
  DEFAULT_MAX_COMPLETION_TOKENS,
  type OpenAICompatConfig,
  type RetryConfig,
} from "./openai-config";
import {
  buildRequestSetup,
  defaultUserAgent,
  fetchWithRetry,
  sleepWithSignal,
  type RequestSetup,
} from "./openai-request";
import { fetchCompletion } from "./openai-nonstream";
import { listProviderModels } from "./openai-models";
import { runStream, type BodyInput, type OpenAIStreamHost } from "./openai-stream";
import { applyPromptTag } from "./openai-prompt-tag";
import { waitForRateLimit } from "./openai-rate-limit";

export type { OpenAICompatConfig, RetryConfig } from "./openai-config";
export { classifyProviderError } from "./openai-errors";

/** Провайдер OpenAI-совместимого API (стрим + non-stream фолбэки, ретраи). */
export class OpenAICompatProvider implements LLMProvider {
  readonly model: string;
  readonly contextWindow: number;
  /** Эффективный лимит completion-токенов (виден потребителям, шлющим свой лимит). */
  readonly maxCompletionTokens: number;
  private config: OpenAICompatConfig;
  private tokenCounter: TokenCounter;
  private retryConfig: RetryConfig;
  private rateLimiter: RateLimiter;
  private debug: ((msg: string, meta?: Record<string, unknown>) => void) | null;
  private getSessionId?: () => string | undefined;
  private userAgent: string;
  private cache?: CacheCapability;
  private cacheReport: CacheReportFormat;
  // Публичные: LLMProvider объявляет их опционально — приватный индикатор
  // сломал бы assignability (INV-R2: обёртки пробрасывают 1:1).
  reasoningStrategy: ReasoningStrategy;
  private reasoningOff: boolean;
  reasoningLevels?: string[];

  constructor(config: OpenAICompatConfig) {
    this.config = config;
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 32768;
    this.maxCompletionTokens = config.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
    this.cache = config.cache;
    this.reasoningStrategy = config.reasoningStrategy ?? "openai-effort"; // INV-R1
    this.reasoningOff = config.reasoningOff === true;
    this.reasoningLevels = config.reasoningLevels;
    // Без capability всё равно читаем OpenAI-совместимые поля: это не меняет
    // запрос и работает для локальных/кастомных серверов.
    this.cacheReport = config.cache?.report ?? "openai";
    this.tokenCounter = new TokenCounter(config.model);
    this.retryConfig = config.retry ?? {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      maxStreamRetries: 2,
      noDataTimeoutMs: 180000,
    };
    // Общий лимитер процесса (аудит §7.8): иначе у каждого экземпляра свой.
    this.rateLimiter = config.rateLimiter ?? createRateLimiter(config.rateLimits);
    this.getSessionId = config.getSessionId;
    this.userAgent = config.userAgent ?? defaultUserAgent();
    this.debug = config.logger ? config.logger.debug.bind(config.logger) : null;
  }

  /**
   * Тишина между чанками, после которой стрим считается мёртвым.
   */
  private get idleTimeoutMs(): number {
    return this.retryConfig.noDataTimeoutMs ?? 180000;
  }

  /**
   * Стрим чата: rate-limit → стрим → фолбэк non-stream при пустом стриме.
   */
  async *chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: ChatOptions,
  ): AsyncIterable<Chunk> {
    // Проверка лимита до запроса: ограниченное ожидание слота, затем
    // recoverable-ошибка (цикл скормит её модели, а не умрёт).
    await waitForRateLimit(this.rateLimiter, (ms, s) => this.sleep(ms, s), signal);

    // Prompt-tag стратегия: дописать /no_think в последнее user-сообщение (только исходящая копия)
    let effectiveMessages = messages;
    if (this.reasoningStrategy === "prompt-tag" && options?.reasoningEffort === "none") {
      effectiveMessages = applyPromptTag(messages, "/no_think");
    }

    const streamResult = runStream(this.streamHost(), effectiveMessages, tools, signal, options);

    let hasToolCall = false;
    let hasText = false;
    let hasReasoning = false;

    for await (const chunk of streamResult) {
      if (chunk.type === "tool_call") hasToolCall = true;
      if (chunk.type === "text") hasText = true;
      if (chunk.type === "reasoning") hasReasoning = true;
      yield chunk;
    }

    // Стрим кончился на reasoning без текста/tool_call: модель ПОДУМАЛА, но
    // ответа не дала (наблюдалось: qwen3.5-9b в LM Studio шлёт reasoning_content
    // и встаёт). Reasoning уже отдан; недостающий ответ добираем non-stream.
    // Reasoning-чанк фолбэка дропаем, чтобы не показать дважды — текста не было,
    // риск дубля ответа отсутствует.
    if (!hasToolCall && !hasText) {
      this.debug?.("LLM streaming produced no text/tool_call — falling back to non-streaming");
      // Фолбэк — продолжение того же хода на медленном железе: ждём столько же,
      // сколько разрешили стриму, а не жёсткие 120с.
      const fallback = await this.doNonStreaming(
        effectiveMessages,
        tools,
        signal,
        options,
        this.idleTimeoutMs,
      );
      this.debug?.("LLM non-streaming fallback result", { chunks: fallback.length });
      for (const chunk of fallback) {
        if (hasReasoning && chunk.type === "reasoning") continue;
        yield chunk;
      }
    }
  }

  /** Разрешённый cap completion-токенов для вызова. */
  private maxTokensFor(options?: ChatOptions): number {
    return options?.maxTokens ?? this.config.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
  }

  /** Тело запроса (стрим и non-stream) — единственное место сборки. */
  private buildBody(input: BodyInput): Record<string, unknown> {
    return buildRequestBody({
      model: this.model,
      messages: input.messages,
      tools: input.tools,
      stream: input.stream,
      maxTokens: input.maxTokens,
      reasoningEffort: input.options?.reasoningEffort,
      reasoningStrategy: this.reasoningStrategy,
      reasoningOff: this.reasoningOff,
      reasoningLevels: this.reasoningLevels,
      ...this.cacheHints(input.options?.sessionId),
    });
  }

  /**
   * Вычисляет запросные подсказки кеша из возможностей провайдера и текущего
   * session id. Без capability возвращает «ничего», сохраняя прежнее тело.
   */
  private cacheHints(overrideSessionId?: string): {
    cachePrompt: boolean;
    promptCacheKey?: string;
    sessionId?: string;
    streamUsage: boolean;
  } {
    const sessionId = overrideSessionId ?? this.getSessionId?.();
    return {
      cachePrompt: this.cache?.requestCachePrompt === true,
      promptCacheKey: this.cache?.requestPromptCacheKey ? sessionId : undefined,
      sessionId: this.cache?.requestSessionId ? sessionId : undefined,
      streamUsage: this.cache?.requestStreamUsage === true,
    };
  }

  /** Общая подготовка запроса: auth-заголовки + таймаут/abort-контроллер. */
  private buildRequestSetup(
    signal?: AbortSignal,
    totalTimeoutMs: number = REQUEST_TIMEOUT_MS,
    overrideSessionId?: string,
  ): RequestSetup {
    return buildRequestSetup({
      userAgent: this.userAgent,
      apiKey: this.config.apiKey,
      sessionId: overrideSessionId ?? this.getSessionId?.(),
      // Когда capability задана — шлём заголовок только тем, кому он нужен
      // (Zen/Go). Без capability сохраняем легаси-поведение.
      sendSessionHeader: this.cache ? this.cache.sessionHeader : true,
      totalTimeoutMs,
      signal,
    });
  }

  private fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    return fetchWithRetry(
      {
        retryConfig: this.retryConfig,
        model: this.model,
        baseUrl: this.config.baseUrl,
        sleep: (ms, signal) => this.sleep(ms, signal),
      },
      url,
      init,
    );
  }

  /** Всё, что стриму нужно от провайдера, без доступа к приватным полям. */
  private streamHost(): OpenAIStreamHost {
    return {
      model: this.model,
      baseUrl: this.config.baseUrl,
      cacheReport: this.cacheReport,
      retryConfig: this.retryConfig,
      idleTimeoutMs: this.idleTimeoutMs,
      debug: this.debug,
      maxTokensFor: (options) => this.maxTokensFor(options),
      buildBody: (input) => this.buildBody(input),
      resolveSessionId: (override) => override ?? this.getSessionId?.(),
      requestSetup: (signal, totalTimeoutMs, overrideSessionId) =>
        this.buildRequestSetup(signal, totalTimeoutMs, overrideSessionId),
      fetchWithRetry: (url, init) => this.fetchWithRetry(url, init),
      nonStreaming: (messages, tools, signal, options, totalTimeoutMs) =>
        this.doNonStreaming(messages, tools, signal, options, totalTimeoutMs),
      sleep: (ms, signal) => this.sleep(ms, signal),
    };
  }

  private doNonStreaming(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: ChatOptions,
    totalTimeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Chunk[]> {
    return fetchCompletion(
      {
        model: this.model,
        baseUrl: this.config.baseUrl,
        cacheReport: this.cacheReport,
        maxTokensFor: (opts) => this.maxTokensFor(opts),
        buildBody: (input) => this.buildBody(input),
        resolveSessionId: (override) => override ?? this.getSessionId?.(),
        requestSetup: (s, t, o) => this.buildRequestSetup(s, t, o),
        fetchWithRetry: (url, init) => this.fetchWithRetry(url, init),
      },
      messages,
      tools,
      signal,
      options,
      totalTimeoutMs,
    );
  }

  /**
   * Считает токены текста (tiktoken по дефолтной модели).
   * @param text текст; @returns число токенов.
   */
  countTokens(text: string): number {
    return this.tokenCounter.count(text);
  }

  /**
   * Список моделей провайдера (`/models`: id/name/model).
   * @returns имена моделей; @throws при недоступности провайдера.
   */
  async listModels(): Promise<string[]> {
    return listProviderModels({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      userAgent: this.userAgent,
    });
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleepWithSignal(ms, signal);
  }
}
