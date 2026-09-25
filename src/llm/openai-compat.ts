import type { LLMProvider, Message, Chunk, ToolDefinition } from "./provider";
import { TokenCounter } from "./token-counter";
import { t } from "../i18n/index";
import { readMmaVersion } from "../core/version";
import { type RateLimiter, createRateLimiter } from "../modules/security/rate-limiter";
import type { CacheCapability, CacheReportFormat, RateLimitConfig } from "../config/types";
import { LlmError } from "./llm-errors";
import { backoffDelay } from "../utils/retry";
import { StreamState } from "./stream-state";
import { parseCacheUsage } from "./cache-usage";

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  /** Extra retries when the response stream breaks BEFORE any content is delivered. */
  maxStreamRetries?: number;
  /** Max silence (ms) between stream chunks before the connection is treated as dead. */
  noDataTimeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 120000;
/** Max wait (ms) for a self-inflicted rate-limit slot before giving up. */
const MAX_RATE_WAIT_MS = 30_000;
/** Completion token cap sent as max_tokens when unset in config. */
const DEFAULT_MAX_COMPLETION_TOKENS = 8192;

/**
 * Client identity header. OpenCode Go asks clients to identify themselves with
 * their own user agent (not a generic SDK/HTTP-library name) so requests route
 * to coding-agent traffic. `readMmaVersion()` is memoized — every provider
 * construction would otherwise re-read package.json.
 */
let cachedUserAgent: string | null = null;
function defaultUserAgent(): string {
  if (cachedUserAgent === null) cachedUserAgent = `micro-models-agent/${readMmaVersion()}`;
  return cachedUserAgent;
}

export interface OpenAICompatConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  maxCompletionTokens?: number;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  /**
   * Live getter for the current conversation id. When it returns a value it is
   * sent as `x-opencode-session` — required by OpenCode Go (400
   * MissingSessionID otherwise) and used for routing/prompt-cache affinity.
   */
  getSessionId?: () => string | undefined;
  /**
   * Cache-возможность провайдера. Когда задана, управляет запросными
   * подсказками кеша и гейтингом `x-opencode-session`. Когда отсутствует —
   * сохраняется легаси-поведение (заголовок шлётся при наличии sessionId).
   */
  cache?: CacheCapability;
  /** Override the User-Agent (defaults to `micro-models-agent/<version>`). */
  userAgent?: string;
  logger?: import("../logger/app-logger").Logger;
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

function buildRequestBody(opts: {
  model: string;
  messages: unknown[];
  tools?: ToolDefinition[];
  stream: boolean;
  maxTokens?: number;
  reasoningEffort?: string;
  reasoningStrategy?: string;
  /** Подсказки кеша (llama.cpp `cache_prompt`). */
  cachePrompt?: boolean;
  /** Ключ кеша для OpenAI (`prompt_cache_key`). */
  promptCacheKey?: string;
  /** Идентификатор для sticky-маршрутизации OpenRouter (`session_id`). */
  sessionId?: string;
  /** Запросить финальный usage-чанк в стриме (`stream_options.include_usage`). */
  streamUsage?: boolean;
}): Record<string, unknown> {
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

  // Apply reasoning effort via the provider's strategy
  const strategy = opts.reasoningStrategy ?? "openai-effort";
  const level = opts.reasoningEffort;

  if (strategy === "openai-effort" && level && level !== "default") {
    body.reasoning_effort = level;
  } else if (strategy === "template-kwarg") {
    body.chat_template_kwargs = { enable_thinking: level !== "none" };
  } else if (strategy === "prompt-tag" && level && level !== "default") {
    // Send reasoning_effort in body (models that respect it via API) AND
    // add /no_think tag to message (models that only respect prompt signals).
    body.reasoning_effort = level;
  }
  // "none" = unsupported, skip

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

export class OpenAICompatProvider implements LLMProvider {
  readonly model: string;
  readonly contextWindow: number;
  private config: OpenAICompatConfig;
  private tokenCounter: TokenCounter;
  private retryConfig: RetryConfig;
  private rateLimiter: RateLimiter;
  private debug: ((msg: string, meta?: Record<string, unknown>) => void) | null;
  private getSessionId?: () => string | undefined;
  private userAgent: string;
  private cache?: CacheCapability;
  private cacheReport: CacheReportFormat;

  constructor(config: OpenAICompatConfig) {
    this.config = config;
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 32768;
    this.cache = config.cache;
    // Без capability всё равно читаем OpenAI-совместимые поля: это не меняет
    // запрос и работает для локальных/кастомных серверов.
    this.cacheReport = config.cache?.report ?? "openai";
    this.tokenCounter = new TokenCounter();
    this.retryConfig = config.retry ?? {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      maxStreamRetries: 2,
      noDataTimeoutMs: 180000,
    };
    this.rateLimiter = createRateLimiter(config.rateLimits);
    this.getSessionId = config.getSessionId;
    this.userAgent = config.userAgent ?? defaultUserAgent();
    this.debug = config.logger ? config.logger.debug.bind(config.logger) : null;
  }

  async *chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: import("./provider").ChatOptions,
  ): AsyncIterable<Chunk> {
    // Check rate limit before making request. A self-inflicted limit should
    // wait for a slot (bounded) instead of aborting a healthy turn; only if
    // no slot frees within the window do we surface a recoverable error the
    // agent loop can feed back (rather than dying).
    if (!this.rateLimiter.canMakeRequest()) {
      const waitMs = Math.min(this.rateLimiter.msUntilRequest(), MAX_RATE_WAIT_MS);
      if (waitMs > 0) {
        await this.sleep(waitMs, signal);
      }
      if (!this.rateLimiter.canMakeRequest()) {
        throw new LlmError(
          `Rate limit exceeded: ${this.rateLimiter.getConfig().maxRequestsPerMinute} requests per minute`,
          { recoverable: true },
        );
      }
    }

    // Record this request
    this.rateLimiter.recordRequest();

    // Apply prompt-tag strategy: append /no_think to last user message (outgoing copy only)
    let effectiveMessages = messages;
    if (options?.reasoningStrategy === "prompt-tag" && options?.reasoningEffort === "none") {
      effectiveMessages = this.applyPromptTag(messages, "/no_think");
    }

    const streamResult = this.doStream(effectiveMessages, tools, signal, options);

    let hasToolCall = false;
    let hasText = false;
    let hasReasoning = false;

    for await (const chunk of streamResult) {
      if (chunk.type === "tool_call") hasToolCall = true;
      if (chunk.type === "text") hasText = true;
      if (chunk.type === "reasoning") hasReasoning = true;
      yield chunk;
    }

    // A stream that ended with reasoning but no text/tool_call means the model
    // THOUGHT but never produced an answer (observed: qwen3.5-9b in LM Studio
    // emits reasoning_content then stops). The streamed reasoning was already
    // delivered; fetch the missing answer via non-streaming. The fallback's
    // own reasoning chunk is dropped so thinking is not shown twice — no text
    // was emitted, so there is no duplicate-answer risk.
    if (!hasToolCall && !hasText) {
      this.debug?.("LLM streaming produced no text/tool_call — falling back to non-streaming");
      const fallback = await this.doNonStreaming(effectiveMessages, tools, signal, options);
      this.debug?.("LLM non-streaming fallback result", { chunks: fallback.length });
      for (const chunk of fallback) {
        if (hasReasoning && chunk.type === "reasoning") continue;
        yield chunk;
      }
    }
  }

  /** Append a tag to the last user message (outgoing copy, never stored in context). */
  private applyPromptTag(messages: Message[], tag: string): Message[] {
    const copy = [...messages];
    for (let i = copy.length - 1; i >= 0; i--) {
      if (copy[i].role === "user") {
        const msg = { ...copy[i] };
        if (typeof msg.content === "string") {
          msg.content = `${msg.content}\n${tag}`;
        } else {
          // Array of parts — append a text part
          msg.content = [...msg.content, { type: "text" as const, text: tag }];
        }
        copy[i] = msg;
        break;
      }
    }
    return copy;
  }

  private async *doStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: import("./provider").ChatOptions,
  ): AsyncIterable<Chunk> {
    const { baseDelay, maxDelay, maxStreamRetries, noDataTimeoutMs } = this.retryConfig;
    const streamRetries = maxStreamRetries ?? 2;
    const idleTimeoutMs = noDataTimeoutMs ?? 180000;
    let usedNonStreamingFallback = false;

    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      const onEmit = (): void => {
        emitted = true;
      };
      try {
        const sawDone = yield* this.streamOnce(messages, tools, signal, options, onEmit, idleTimeoutMs);
        // Clean [DONE] or any partial content → deliver what we have.
        if (sawDone || emitted) return;
        // Stream closed before [DONE] with zero content → retryable truncation.
        if (attempt >= streamRetries) return;
      } catch (err: any) {
        if (err?.name === "AbortError" || (err instanceof LlmError && err.terminal) || signal?.aborted) throw err;

        // Buffered-SSE stall after tool_call deltas: re-request non-streaming
        // once. Streaming is the broken path here, so retrying the same way
        // would stall again; the agent must still get its tool_call.
        if (err?.stalledAfterToolCall === true && !usedNonStreamingFallback) {
          usedNonStreamingFallback = true;
          this.debug?.(
            "LLM stream stalled after tool_call — falling back to non-streaming request",
          );
          const fallback = await this.doNonStreaming(messages, tools, signal, options);
          this.debug?.("LLM non-streaming fallback result", { chunks: fallback.length });
          for (const chunk of fallback) {
            // Reasoning was likely already streamed before the stall; drop the
            // fallback's copy to avoid duplicating thinking.
            if (chunk.type === "reasoning") continue;
            yield chunk;
          }
          return;
        }

        // Content was already delivered — a re-stream would duplicate chunks.
        if (emitted || attempt >= streamRetries) throw err;
        // Connection dropped before any content → retry the whole request.
      }
      // Экспоненциальный backoff с джиттером (общий хелпер из src/utils).
      await this.sleep(backoffDelay(attempt, baseDelay, maxDelay, 0.1), signal);
    }
  }

  private async *streamOnce(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    signal: AbortSignal | undefined,
    options: import("./provider").ChatOptions | undefined,
    onEmit: () => void,
    idleTimeoutMs: number,
  ): AsyncGenerator<Chunk, boolean> {
    const maxTokens = options?.maxTokens ?? this.config.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
    const body = buildRequestBody({
      model: this.model,
      messages,
      tools,
      stream: true,
      maxTokens,
      reasoningEffort: options?.reasoningEffort,
      reasoningStrategy: options?.reasoningStrategy,
      ...this.cacheHints(),
    });
    this.debug?.("LLM stream request", {
      baseUrl: this.config.baseUrl,
      model: this.model,
      stream: true,
      maxTokens,
      toolsCount: tools?.length ?? 0,
      reasoningEffort: options?.reasoningEffort,
      reasoningStrategy: options?.reasoningStrategy,
      messagesCount: messages.length,
    });
    const { headers, abortSignal, cleanup, isTimeout, flagTimeout, controller } =
      this.buildRequestSetup(signal);

    let response: Response;
    try {
      response = await this.fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortSignal,
      });
    } catch (err: any) {
      // Fetch-level failures are already HTTP-retried inside fetchWithRetry —
      // don't double-retry them at the stream level.
      if (err?.name === "AbortError") throw err;
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (wrapped instanceof LlmError) {
        wrapped.markTerminal();
        throw wrapped;
      }
      throw new LlmError(wrapped.message).markTerminal();
    }

    if (!response.ok) {
      cleanup();
      const errorText = await response.text();
      throw new LlmError(
        t("error.llm_api", {
          status: response.status,
          statusText: response.statusText,
          errorText,
        }),
        { terminal: true },
      );
    }

    const contentType = response.headers?.get?.("content-type") ?? "";
    this.debug?.("LLM stream response headers", {
      status: response.status,
      contentType,
    });

    const reader = response.body?.getReader();
    if (!reader) {
      cleanup();
      throw new Error(t("error.no_response_body"));
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallAccs = new Map<number, ToolCallAcc>();
    // Единый контейнер состояния стрима (вместо 9 разрозненных флагов).
    const st = new StreamState();

    type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
    // Stall after tool_call deltas started usually means the provider buffers
    // SSE instead of streaming argument deltas (seen with LM Studio). Mark the
    // error so `doStream` can retry the request non-streaming instead of
    // failing the whole run.
    const idleError = (): Error => {
      const e = new Error(
        t(
          st.sawToolCallStart ? "error.llm_stream_idle_toolcall" : "error.llm_stream_idle",
          { timeout: idleTimeoutMs },
        ),
      );
      (e as { stalledAfterToolCall?: boolean }).stalledAfterToolCall = st.sawToolCallStart;
      return e;
    };
    const readIdle = (): Promise<ReadResult> =>
      new Promise<ReadResult>((resolve, reject) => {
        const idleTimer = setTimeout(() => {
          flagTimeout();
          controller.abort();
        }, idleTimeoutMs);
        reader.read().then(
          (result) => {
            clearTimeout(idleTimer);
            if (isTimeout()) reject(idleError());
            else resolve(result);
          },
          (err) => {
            clearTimeout(idleTimer);
            if (isTimeout()) reject(idleError());
            else reject(err);
          },
        );
      });

    try {
      while (true) {
        const { done, value } = await readIdle();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let data: string;
          if (trimmed.startsWith("data: ")) {
            data = trimmed.slice(6);
            if (data === "[DONE]") {
              st.sawDone = true;
              continue;
            }
          } else {
            // Not SSE-framed — Ollama (and some other backends) may stream
            // NDJSON or send mid-stream errors as bare JSON. Try to parse the
            // raw line; unparseable noise (SSE comments, keep-alives) is
            // counted and skipped.
            st.nonDataLines++;
            if (st.nonDataSamples.length < 5) st.nonDataSamples.push(trimmed.slice(0, 200));
            data = trimmed;
          }

          try {
            const parsed = JSON.parse(data);
            st.parsedChunks++;
            const choice = parsed.choices?.[0];
            if (!choice) {
              // Usage comes in the last chunk with empty choices
              if (parsed.usage) {
                st.usage = {
                  promptTokens: parsed.usage.prompt_tokens ?? 0,
                  completionTokens: parsed.usage.completion_tokens ?? 0,
                  totalTokens: parsed.usage.total_tokens ?? 0,
                  cache: parseCacheUsage(parsed.usage, this.cacheReport),
                };
                this.debug?.("LLM stream usage", { ...st.usage });
              } else if (parsed.error) {
                // Mid-stream provider error (Ollama sends {"error": "..."} as
                // bare JSON once generation already started). Surface it —
                // swallowing it makes the response look silently empty.
                // Thrown OUTSIDE the JSON-parse try/catch below.
                st.midStreamError = String(parsed.error);
              }
              // NOTE: no `continue` here — it would skip the midStreamError
              // throw below (which lives outside this try/catch).
            } else {
              if (st.parsedChunks <= 3 || st.parsedChunks % 50 === 0) {
                const d = choice.delta ?? {};
                this.debug?.("LLM stream chunk", {
                  n: st.parsedChunks,
                  finishReason: choice.finish_reason ?? null,
                  deltaKeys: Object.keys(d),
                });
              }

              const delta = choice.delta || {};
              const finishReason = choice.finish_reason;
              if (finishReason) st.lastFinishReason = finishReason;

              // `reasoning` is the Ollama alias for OpenAI's `reasoning_content`.
              const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
              if (reasoningDelta) {
                onEmit();
                yield { type: "reasoning", content: reasoningDelta };
              }

              if (delta.tool_calls) {
                st.sawToolCallStart = true;
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallAccs.has(idx)) {
                    toolCallAccs.set(idx, { id: "", name: "", arguments: "" });
                  }
                  const acc = toolCallAccs.get(idx)!;
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name) acc.name = tc.function.name;
                  if (tc.function?.arguments) {
                    acc.arguments += tc.function.arguments;
                  }
                }
              }

              if (delta.content) {
                onEmit();
                st.sawText = true;
                yield { type: "text", content: delta.content };
              }

              if (finishReason === "tool_calls" && toolCallAccs.size > 0) {
                for (const [, acc] of toolCallAccs) {
                  if (acc.name) {
                    onEmit();
                    yield {
                      type: "tool_call",
                      toolCall: {
                        id: acc.id,
                        name: acc.name,
                        arguments: acc.arguments || "{}",
                      },
                    };
                  }
                }
                toolCallAccs.clear();
              }
            }
          } catch {
            // Skip malformed JSON lines
          }
          if (st.midStreamError) {
            throw new Error(
              t("error.llm_provider_stream_error", { error: st.midStreamError.slice(0, 300) }),
            );
          }
        }
      }
      if (st.usage) {
        onEmit();
        yield { type: "done", usage: st.usage };
      }

      // finish_reason "length": the completion hit the token limit. An
      // unfinished tool_call would otherwise be silently swallowed (tool_calls
      // are only yielded on finish_reason "tool_calls") and surface as an
      // empty response → blind hallucination retries. Surface the real cause.
      if (st.lastFinishReason === "length") {
        const truncatedToolCall = st.sawToolCallStart && toolCallAccs.size > 0;
        if (truncatedToolCall || !st.sawText) {
          // Провайдер в порядке — модель просто превысила completion-лимит.
          // terminal: стрим не ретраим (он завершился корректно); recoverable:
          // агентный цикл вернёт причину модели, чтобы она адаптировалась
          // (разбила вывод) вместо смерти сессии.
          throw new LlmError(
            t(truncatedToolCall ? "error.llm_truncated_toolcall" : "error.llm_truncated", {
              tokens: maxTokens,
            }),
            { terminal: true, recoverable: true },
          );
        }
        // Текст уже устримлен и не завершён — не глушим ответ, но и не
        // принимаем обрезок молча: отдаём видимое предупреждение.
        yield {
          type: "warning",
          content: t("error.llm_output_truncated", { tokens: maxTokens }),
        };
      }
    } finally {
      cleanup();
      reader.releaseLock();
      this.debug?.("LLM stream finished", st.snapshot());
    }
    return st.sawDone;
  }

  /**
   * Вычисляет запросные подсказки кеша из возможностей провайдера и текущего
   * session id. Без capability возвращает «ничего», сохраняя прежнее тело.
   */
  private cacheHints(): {
    cachePrompt: boolean;
    promptCacheKey?: string;
    sessionId?: string;
    streamUsage: boolean;
  } {
    const sessionId = this.getSessionId?.();
    return {
      cachePrompt: this.cache?.requestCachePrompt === true,
      promptCacheKey: this.cache?.requestPromptCacheKey ? sessionId : undefined,
      sessionId: this.cache?.requestSessionId ? sessionId : undefined,
      streamUsage: this.cache?.requestStreamUsage === true,
    };
  }

  /** Shared request setup: auth headers + timeout/abort controller wiring. */
  private buildRequestSetup(signal?: AbortSignal): {
    headers: Record<string, string>;
    abortSignal: AbortSignal;
    cleanup: () => void;
    isTimeout: () => boolean;
    flagTimeout: () => void;
    controller: AbortController;
  } {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.config.apiKey && this.config.apiKey !== "not-needed") {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    const sessionId = this.getSessionId?.();
    // Когда capability задана — шлём заголовок только тем, кому он нужен
    // (Zen/Go). Без capability сохраняем легаси-поведение.
    const sendSessionHeader = this.cache ? this.cache.sessionHeader : true;
    if (sessionId && sendSessionHeader) headers["x-opencode-session"] = sessionId;
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const abortSignal: AbortSignal = (() => {
      if (!signal) return controller.signal;
      try {
        return AbortSignal.any([controller.signal, signal]);
      } catch {
        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
        return controller.signal;
      }
    })();
    return {
      headers,
      abortSignal,
      cleanup: () => clearTimeout(timeoutId),
      isTimeout: () => timedOut,
      flagTimeout: () => {
        timedOut = true;
      },
      controller,
    };
  }

  private async doNonStreaming(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: import("./provider").ChatOptions,
  ): Promise<Chunk[]> {
    const maxTokens = options?.maxTokens ?? this.config.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
    const body = buildRequestBody({
      model: this.model,
      messages,
      tools,
      stream: false,
      maxTokens,
      reasoningEffort: options?.reasoningEffort,
      reasoningStrategy: options?.reasoningStrategy,
      ...this.cacheHints(),
    });

    const { headers, abortSignal, cleanup, isTimeout } = this.buildRequestSetup(signal);

    try {
      const response = await this.fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          t("error.llm_api", {
            status: response.status,
            statusText: response.statusText,
            errorText: errorText.slice(0, 500),
          }),
        );
      }

      const data = await response.json();
      // Some backends (e.g. Ollama) return HTTP 200 with {"error": "..."}.
      if (data.error && !data.choices) {
        throw new Error(t("error.llm_provider_stream_error", { error: String(data.error).slice(0, 300) }));
      }
      const choice = data.choices?.[0];
      if (!choice) {
        return [];
      }

      const msg = choice.message || {};
      const chunks: Chunk[] = [];

      const reasoning = msg.reasoning_content ?? msg.reasoning;
      if (reasoning) {
        chunks.push({ type: "reasoning", content: reasoning });
      }
      if (msg.content) {
        chunks.push({ type: "text", content: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chunks.push({
            type: "tool_call",
            toolCall: {
              id: tc.id || "",
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "{}",
            },
          });
        }
      }

      // Completed text but hit the cap: surface a visible warning instead of
      // silently accepting a cut-off answer (see the streaming path).
      if (choice.finish_reason === "length" && msg.content && !msg.tool_calls) {
        chunks.push({
          type: "warning",
          content: t("error.llm_output_truncated", { tokens: maxTokens }),
        });
      }

      // Append usage from API response
      if (data.usage) {
        chunks.push({
          type: "done",
          usage: {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
            cache: parseCacheUsage(data.usage, this.cacheReport),
          },
        });
      }

      return chunks;
    } catch (err: any) {
      if (isTimeout() && err?.name === "AbortError") {
        throw new Error(t("error.llm_timeout", { timeout: REQUEST_TIMEOUT_MS }));
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      cleanup();
    }
  }

  countTokens(text: string): number {
    return this.tokenCounter.count(text);
  }

  async listModels(): Promise<string[]> {
    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, "")}/models`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      };
      if (this.config.apiKey && this.config.apiKey !== "not-needed") {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        // Surface the failure: health probes must distinguish a dead
        // provider from one that serves an empty model list.
        throw new Error(`HTTP ${response.status} from ${url}`);
      }

      const data: unknown = await response.json();
      const rawList: unknown[] = Array.isArray(data)
        ? data
        : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).data)
          ? ((data as Record<string, unknown>).data as unknown[])
          : [];
      const models = rawList
        .map((m) => {
          if (m && typeof m === "object") {
            const obj = m as Record<string, unknown>;
            for (const key of ["id", "name", "model"]) {
              const v = obj[key];
              if (typeof v === "string" && v) return v;
            }
          }
          return "";
        })
        .filter(Boolean);
      return models;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const { maxRetries, baseDelay, maxDelay } = this.retryConfig;
    let lastStatus = 0;
    let lastRetryAfter = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      lastRetryAfter = 0;
      try {
        const response = await fetch(url, init);
        if (!this.isRetryable(response.status)) return response;
        lastStatus = response.status;
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        lastRetryAfter = retryAfter > 0 ? retryAfter * 1000 : 0;
      } catch (err: any) {
        if (err.name === "AbortError") {
          throw err;
        }
        if (attempt === maxRetries) throw err;
      }

      if (attempt < maxRetries) {
        // Prefer the provider's Retry-After window (saturating at maxDelay);
        // otherwise exponential backoff. 429s from free tiers need a real wait.
        const delay = lastRetryAfter > 0
          ? Math.min(lastRetryAfter, maxDelay)
          : backoffDelay(attempt, baseDelay, maxDelay, 0.1);
        await this.sleep(delay, init.signal ?? undefined);
      }
    }

    if (lastStatus === 429) {
      throw new LlmError(
        t("error.llm_429", {
          model: this.model,
          baseUrl: this.config.baseUrl,
        }),
        { llmStatus: lastStatus },
      );
    }
    throw new LlmError(t("error.llm_retries"), { llmStatus: lastStatus });
  }

  private isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
