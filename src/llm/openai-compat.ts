import type { LLMProvider, Message, Chunk, ToolDefinition } from "./provider";
import { TokenCounter } from "./token-counter";
import { t } from "../i18n/index";
import { RateLimiter, createRateLimiter } from "../modules/security/rate-limiter";
import type { RateLimitConfig } from "../config/types";

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

export interface OpenAICompatConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  maxCompletionTokens?: number;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
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
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: opts.stream,
  };
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.reasoningEffort) {
    body.reasoning_effort = opts.reasoningEffort;
  }
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

  constructor(config: OpenAICompatConfig) {
    this.config = config;
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 32768;
    this.tokenCounter = new TokenCounter();
    this.retryConfig = config.retry ?? {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      maxStreamRetries: 2,
      noDataTimeoutMs: 60000,
    };
    this.rateLimiter = createRateLimiter(config.rateLimits);
  }

  async *chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: import("./provider").ChatOptions,
  ): AsyncIterable<Chunk> {
    // Check rate limit before making request
    if (!this.rateLimiter.canMakeRequest()) {
      throw new Error(
        `Rate limit exceeded: ${this.rateLimiter.getConfig().maxRequestsPerMinute} requests per minute`,
      );
    }

    // Record this request
    this.rateLimiter.recordRequest();

    const streamResult = this.doStream(messages, tools, signal, options);

    let hasToolCall = false;
    let hasText = false;

    for await (const chunk of streamResult) {
      if (chunk.type === "tool_call") hasToolCall = true;
      if (chunk.type === "text") hasText = true;
      yield chunk;
    }

    if (!hasToolCall && !hasText) {
      const fallback = await this.doNonStreaming(messages, tools, signal, options);
      for (const chunk of fallback) {
        yield chunk;
      }
    }
  }

  private async *doStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: import("./provider").ChatOptions,
  ): AsyncIterable<Chunk> {
    const { baseDelay, maxDelay, maxStreamRetries, noDataTimeoutMs } = this.retryConfig;
    const streamRetries = maxStreamRetries ?? 2;
    const idleTimeoutMs = noDataTimeoutMs ?? 60000;

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
        if (err?.name === "AbortError" || err?.llmTerminal || signal?.aborted) throw err;
        // Content was already delivered — a re-stream would duplicate chunks.
        if (emitted || attempt >= streamRetries) throw err;
        // Connection dropped before any content → retry the whole request.
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = Math.random() * baseDelay * 0.1;
      await this.sleep(delay + jitter, signal);
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
    const body = buildRequestBody({
      model: this.model,
      messages,
      tools,
      stream: true,
      maxTokens: options?.maxTokens ?? this.config.maxCompletionTokens ?? 4096,
      reasoningEffort: options?.reasoningEffort,
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
      (wrapped as any).llmTerminal = true;
      throw wrapped;
    }

    if (!response.ok) {
      cleanup();
      const errorText = await response.text();
      const err = new Error(
        t("error.llm_api", {
          status: response.status,
          statusText: response.statusText,
          errorText,
        }),
      );
      (err as any).llmTerminal = true;
      throw err;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      cleanup();
      throw new Error(t("error.no_response_body"));
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallAccs = new Map<number, ToolCallAcc>();

    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    let sawDone = false;

    type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
    const readIdle = (): Promise<ReadResult> =>
      new Promise<ReadResult>((resolve, reject) => {
        const idleTimer = setTimeout(() => {
          flagTimeout();
          controller.abort();
        }, idleTimeoutMs);
        reader.read().then(
          (result) => {
            clearTimeout(idleTimer);
            if (isTimeout()) reject(new Error(t("error.llm_stream_idle", { timeout: idleTimeoutMs })));
            else resolve(result);
          },
          (err) => {
            clearTimeout(idleTimer);
            if (isTimeout()) reject(new Error(t("error.llm_stream_idle", { timeout: idleTimeoutMs })));
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
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            sawDone = true;
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) {
              // Usage comes in the last chunk with empty choices
              if (parsed.usage) {
                usage = {
                  promptTokens: parsed.usage.prompt_tokens ?? 0,
                  completionTokens: parsed.usage.completion_tokens ?? 0,
                  totalTokens: parsed.usage.total_tokens ?? 0,
                };
              }
              continue;
            }

            const delta = choice.delta || {};
            const finishReason = choice.finish_reason;

            if (delta.reasoning_content) {
              onEmit();
              yield { type: "reasoning", content: delta.reasoning_content };
            }

            if (delta.tool_calls) {
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
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
      if (usage) {
        onEmit();
        yield { type: "done", usage };
      }
    } finally {
      cleanup();
      reader.releaseLock();
    }
    return sawDone;
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
    };
    if (this.config.apiKey && this.config.apiKey !== "not-needed") {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
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
    const body = buildRequestBody({
      model: this.model,
      messages,
      tools,
      stream: false,
      maxTokens: options?.maxTokens ?? this.config.maxCompletionTokens ?? 4096,
      reasoningEffort: options?.reasoningEffort,
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
      const choice = data.choices?.[0];
      if (!choice) {
        return [];
      }

      const msg = choice.message || {};
      const chunks: Chunk[] = [];

      if (msg.reasoning_content) {
        chunks.push({ type: "reasoning", content: msg.reasoning_content });
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

      // Append usage from API response
      if (data.usage) {
        chunks.push({
          type: "done",
          usage: {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
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
      };
      if (this.config.apiKey && this.config.apiKey !== "not-needed") {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as any;
      const models = (data.data || data || [])
        .map((m: any) => m.id || m.name || m.model || "")
        .filter(Boolean);
      return models;
    } catch {
      return [];
    }
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const { maxRetries, baseDelay, maxDelay } = this.retryConfig;
    let lastStatus = 0;
    let lastRetryAfter = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
          : Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        const jitter = Math.random() * baseDelay * 0.1;
        await this.sleep(delay + jitter, init.signal ?? undefined);
      }
    }

    if (lastStatus === 429) {
      throw new Error(
        t("error.llm_429", {
          model: this.model,
          baseUrl: this.config.baseUrl,
        }),
      );
    }
    throw new Error(t("error.llm_retries"));
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
