/**
 * HTTP-обвязка OpenAI-совместимого провайдера: auth-заголовки, таймауты и
 * ретраи с учётом Retry-After. Вынесено из `openai-compat.ts` (правило 6).
 */
import { readMmaVersion } from "../core/version";
import { t } from "../i18n/index";
import { backoffDelay } from "../utils/retry";
import { LlmError } from "./llm-errors";
import type { RetryConfig } from "./openai-config";

/**
 * OpenCode Go требует, чтобы клиенты представлялись своим user agent (для
 * роутинга coding-agent трафика). `readMmaVersion()` мемоизирован.
 */
let cachedUserAgent: string | null = null;
export function defaultUserAgent(): string {
  if (cachedUserAgent === null) cachedUserAgent = `micro-models-agent/${readMmaVersion()}`;
  return cachedUserAgent;
}

export interface RequestSetupOptions {
  userAgent: string;
  apiKey?: string;
  sessionId?: string;
  /** Слать ли `x-opencode-session` (без capability — легаси-поведение). */
  sendSessionHeader: boolean;
  totalTimeoutMs: number;
  signal?: AbortSignal;
}

export interface RequestSetup {
  headers: Record<string, string>;
  abortSignal: AbortSignal;
  cleanup: () => void;
  isTimeout: () => boolean;
  flagTimeout: () => void;
  controller: AbortController;
}

/** Общая подготовка запроса: auth-заголовки + таймаут/abort-контроллер. */
export function buildRequestSetup(opts: RequestSetupOptions): RequestSetup {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": opts.userAgent,
  };
  if (opts.apiKey && opts.apiKey !== "not-needed") {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  // Когда capability задана — шлём заголовок только тем, кому он нужен
  // (Zen/Go). Без capability сохраняем легаси-поведение.
  if (opts.sessionId && opts.sendSessionHeader) {
    headers["x-opencode-session"] = opts.sessionId;
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.totalTimeoutMs);
  const abortSignal: AbortSignal = (() => {
    if (!opts.signal) return controller.signal;
    try {
      return AbortSignal.any([controller.signal, opts.signal]);
    } catch {
      opts.signal.addEventListener("abort", () => controller.abort(), {
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

export interface RetryContext {
  retryConfig: RetryConfig;
  model: string;
  baseUrl: string;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(
  ctx: RetryContext,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const { maxRetries, baseDelay, maxDelay } = ctx.retryConfig;
  let lastStatus = 0;
  let lastRetryAfter = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastRetryAfter = 0;
    try {
      const response = await fetch(url, init);
      if (!isRetryableStatus(response.status)) return response;
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
      // Приоритет окну Retry-After провайдера (cap на maxDelay); иначе —
      // экспоненциальный backoff. 429 с free-тарифов требуют реального ожидания.
      const delay = lastRetryAfter > 0
        ? Math.min(lastRetryAfter, maxDelay)
        : backoffDelay(attempt, baseDelay, maxDelay, 0.1);
      await ctx.sleep(delay, init.signal ?? undefined);
    }
  }

  if (lastStatus === 429) {
    throw new LlmError(
      t("error.llm_429", {
        model: ctx.model,
        baseUrl: ctx.baseUrl,
      }),
      { llmStatus: lastStatus },
    );
  }
  throw new LlmError(t("error.llm_retries"), { llmStatus: lastStatus });
}

export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
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
