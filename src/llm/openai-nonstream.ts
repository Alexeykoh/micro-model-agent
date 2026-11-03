/**
 * Non-stream запрос `/chat/completions` OpenAI-совместимого провайдера.
 * Вынесено из `doNonStreaming` (`openai-compat.ts`, правило 6); разбор ответа —
 * в `openai-completion.ts`.
 */
import type { Message, Chunk, ToolDefinition, ChatOptions } from "./provider";
import type { CacheReportFormat } from "../config/types";
import { t } from "../i18n/index";
import { LlmError } from "./llm-errors";
import { captureRequestSnapshot } from "./request-snapshot";
import { LLM_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS } from "../config/timeouts";
import { completionToChunks } from "./openai-completion";
import type { BodyInput } from "./openai-stream";
import type { RequestSetup } from "./openai-request";

export interface NonStreamHost {
  model: string;
  baseUrl: string;
  cacheReport: CacheReportFormat;
  maxTokensFor(options?: ChatOptions): number;
  buildBody(input: BodyInput): Record<string, unknown>;
  resolveSessionId(override?: string): string | undefined;
  requestSetup(signal?: AbortSignal, totalTimeoutMs?: number, overrideSessionId?: string): RequestSetup;
  fetchWithRetry(url: string, init: RequestInit): Promise<Response>;
}

/** Один non-stream запрос: заголовки, ретраи, разбор ответа и usage. */
export async function fetchCompletion(
  host: NonStreamHost,
  messages: Message[],
  tools?: ToolDefinition[],
  signal?: AbortSignal,
  options?: ChatOptions,
  totalTimeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Chunk[]> {
  const maxTokens = host.maxTokensFor(options);
  const body = host.buildBody({ stream: false, maxTokens, messages, tools, options });
  // U20: снимок non-stream вызова — то же тело, что уйдёт в сеть.
  captureRequestSnapshot(body, {
    model: host.model,
    baseUrl: host.baseUrl,
    stream: false,
    sessionId: host.resolveSessionId(options?.sessionId),
  });

  const { headers, abortSignal, cleanup, isTimeout } = host.requestSetup(
    signal,
    totalTimeoutMs,
    options?.sessionId,
  );

  try {
    const response = await host.fetchWithRetry(`${host.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LlmError(
        t("error.llm_api", {
          status: response.status,
          statusText: response.statusText,
          errorText: errorText.slice(0, 500),
        }),
        { llmStatus: response.status },
      );
    }

    const data = await response.json();
    return completionToChunks(data, host.cacheReport, maxTokens);
  } catch (err: any) {
    if (isTimeout() && err?.name === "AbortError") {
      throw new Error(t("error.llm_timeout", { timeout: totalTimeoutMs }));
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    cleanup();
  }
}
