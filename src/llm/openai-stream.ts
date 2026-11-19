/**
 * Движок стрима OpenAI-совместимого провайдера: ретраи, idle-таймер, разбор
 * SSE и финальный `done`. Вынесено из `openai-compat.ts` (правило 6); тело
 * запроса и HTTP-обвязка приходят через `OpenAIStreamHost`.
 */
import type { Message, Chunk, ToolDefinition, ChatOptions } from "./provider";
import type { CacheReportFormat } from "../config/types";
import { t } from "../i18n/index";
import { LlmError } from "./llm-errors";
import { StreamState } from "./stream-state";
import { captureRequestSnapshot } from "./request-snapshot";
import { backoffDelay } from "../utils/retry";
import { LLM_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS } from "../config/timeouts";
import type { RetryConfig } from "./openai-config";
import type { RequestSetup } from "./openai-request";
import { parseStreamLine, type ToolCallAcc } from "./openai-sse";
import { classifyProviderError } from "./openai-errors";
import { finalizeStream } from "./openai-stream-final";

export interface BodyInput {
  stream: boolean;
  maxTokens: number;
  messages: Message[];
  tools?: ToolDefinition[];
  options?: ChatOptions;
}

/** Всё, что стриму нужно от провайдера (без доступа к его приватным полям). */
export interface OpenAIStreamHost {
  model: string;
  baseUrl: string;
  cacheReport: CacheReportFormat;
  retryConfig: RetryConfig;
  idleTimeoutMs: number;
  debug: ((msg: string, meta?: Record<string, unknown>) => void) | null;
  maxTokensFor(options?: ChatOptions): number;
  buildBody(input: BodyInput): Record<string, unknown>;
  resolveSessionId(override?: string): string | undefined;
  requestSetup(signal?: AbortSignal, totalTimeoutMs?: number, overrideSessionId?: string): RequestSetup;
  fetchWithRetry(url: string, init: RequestInit): Promise<Response>;
  nonStreaming(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: ChatOptions,
    totalTimeoutMs?: number,
  ): Promise<Chunk[]>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Стрим с ретраями: чистый `[DONE]`/частичный контент отдаём, обрыв ДО
 * контента переспрашиваем, stall после tool_call — non-stream фолбэком.
 */
export async function* runStream(
  host: OpenAIStreamHost,
  messages: Message[],
  tools?: ToolDefinition[],
  signal?: AbortSignal,
  options?: ChatOptions,
): AsyncIterable<Chunk> {
  const { baseDelay, maxDelay, maxStreamRetries } = host.retryConfig;
  const streamRetries = maxStreamRetries ?? 2;
  const idleTimeoutMs = host.idleTimeoutMs;
  let usedNonStreamingFallback = false;

  for (let attempt = 0; ; attempt++) {
    let emitted = false;
    const onEmit = (): void => {
      emitted = true;
    };
    try {
      const sawDone = yield* streamOnce(host, messages, tools, signal, options, onEmit, idleTimeoutMs);
      // Чистый [DONE] или частичный контент — отдаём что есть.
      if (sawDone || emitted) return;
      // Стрим закрылся до [DONE] с нулевым контентом — ретраябельная обрезка.
      if (attempt >= streamRetries) return;
    } catch (err: unknown) {
      if ((err instanceof Error && err.name === "AbortError") || (err instanceof LlmError && err.terminal) || signal?.aborted) throw err;

      // Stall буферизованного SSE после tool_call-дельт: один раз переспрашиваем
      // non-stream. Стрим тут — битый путь, повтор тем же способом снова
      // встанет; а tool_call агент получить обязан.
      const stalled = (err as { stalledAfterToolCall?: unknown } | null)?.stalledAfterToolCall;
      if (stalled === true && !usedNonStreamingFallback) {
        usedNonStreamingFallback = true;
        host.debug?.(
          "LLM stream stalled after tool_call — falling back to non-streaming request",
        );
        // Тот же ход на медленном железе: non-stream ждёт idle-лимит,
        // а не жёсткие 120с (иначе фолбэк умрёт раньше, чем умер бы стрим).
        const fallback = await host.nonStreaming(
          messages,
          tools,
          signal,
          options,
          idleTimeoutMs,
        );
        host.debug?.("LLM non-streaming fallback result", { chunks: fallback.length });
        for (const chunk of fallback) {
          // Reasoning до stall уже, вероятно, устримлен; копию фолбэка дропаем,
          // чтобы не дублировать мышление.
          if (chunk.type === "reasoning") continue;
          yield chunk;
        }
        return;
      }

      // Контент уже отдан — перестрим продублировал бы чанки.
      if (emitted || attempt >= streamRetries) throw err;
      // Обрыв до любого контента — переспрашиваем целиком.
    }
    // Экспоненциальный backoff с джиттером (общий хелпер из src/utils).
    await host.sleep(backoffDelay(attempt, baseDelay, maxDelay, 0.1), signal);
  }
}

async function* streamOnce(
  host: OpenAIStreamHost,
  messages: Message[],
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
  options: ChatOptions | undefined,
  onEmit: () => void,
  idleTimeoutMs: number,
): AsyncGenerator<Chunk, boolean> {
  const maxTokens = host.maxTokensFor(options);
  const body = host.buildBody({ stream: true, maxTokens, messages, tools, options });
  host.debug?.("LLM stream request", {
    baseUrl: host.baseUrl,
    model: host.model,
    stream: true,
    maxTokens,
    toolsCount: tools?.length ?? 0,
    reasoningEffort: options?.reasoningEffort,
    messagesCount: messages.length,
  });
  // U20: снимок того, что реально уйдёт в сеть (после DLP-проекции).
  captureRequestSnapshot(body, {
    model: host.model,
    baseUrl: host.baseUrl,
    stream: true,
    sessionId: host.resolveSessionId(options?.sessionId),
  });
  const { headers, abortSignal, cleanup, isTimeout, flagTimeout, controller } =
    host.requestSetup(signal, REQUEST_TIMEOUT_MS, options?.sessionId);

  let response: Response;
  try {
    response = await host.fetchWithRetry(`${host.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    });
  } catch (err: unknown) {
    // Fetch-сбои уже HTTP-ретраятся внутри fetchWithRetry —
    // на уровне стрима повторно не ретраим.
    // Аборт по total-дедлайну до headers — честный llm_timeout, а не голый
    // AbortError (иначе причина «ждали коннект 120с» теряется).
    // Пользовательский abort (isTimeout() === false) — пробрасываем как был.
    if (err instanceof Error && err.name === "AbortError") {
      if (isTimeout()) {
        throw new Error(t("error.llm_timeout", { timeout: REQUEST_TIMEOUT_MS }));
      }
      throw err;
    }
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
    // context-length 400 → recoverable: агент компактит и повторяет.
    const kind = classifyProviderError(errorText);
    throw new LlmError(
      t("error.llm_api", {
        status: response.status,
        statusText: response.statusText,
        errorText,
      }),
      kind === "context_length"
        ? { terminal: true, recoverable: true, kind, llmStatus: response.status }
        : { terminal: true, llmStatus: response.status },
    );
  }

  const contentType = response.headers?.get?.("content-type") ?? "";
  host.debug?.("LLM stream response headers", {
    status: response.status,
    contentType,
  });

  const reader = response.body?.getReader();
  if (!reader) {
    cleanup();
    throw new Error(t("error.no_response_body"));
  }
  // Сервер ответил headers — он жив. Total-дедлайн (120с на весь запрос)
  // дальше только вредил бы: медленная генерация на слабом железе длится
  // дольше, хотя данные текут. Разоружаем его; тело охраняет per-read
  // idle-таймер (retry.noDataTimeoutMs). Бонус: аборт в фазе тела теперь
  // может прийти только от idle-таймера — сообщение «нет данных Nмс»
  // снова честное, а не маска total-дедлайна.
  // Фаза коннекта (до headers) по-прежнему под total-дедлайном.
  cleanup();

  const decoder = new TextDecoder();
  let buffer = "";
  const toolCallAccs = new Map<number, ToolCallAcc>();
  // Единый контейнер состояния стрима (вместо 9 разрозненных флагов).
  const st = new StreamState();

  type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
  // Stall после старта tool_call-дельт обычно значит: провайдер буферизует
  // SSE вместо стрима дельт аргументов (видели на LM Studio). Помечаем ошибку,
  // чтобы `runStream` переспросил non-stream вместо провала всего прогона.
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
        for (const chunk of parseStreamLine(line, st, toolCallAccs, host.cacheReport, host.debug)) {
          onEmit();
          yield chunk;
        }
      }
    }
    // `done`/usage и обрезка по completion-лимиту — единая точка финала.
    for (const chunk of finalizeStream(st, toolCallAccs, maxTokens)) {
      onEmit();
      yield chunk;
    }
  } finally {
    cleanup();
    reader.releaseLock();
    host.debug?.("LLM stream finished", st.snapshot());
  }
  return st.sawDone;
}
