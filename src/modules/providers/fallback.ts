// src/modules/providers/fallback.ts
import type {
  ChatOptions,
  LLMProvider,
  Message,
  ToolDefinition,
} from "../../llm/provider";
import { LlmError } from "../../llm/llm-errors";

/**
 * Minimal surface of ProviderManager the failover wrapper needs. Structural
 * typing lets tests inject a stub without constructing a real manager.
 */
export interface FallbackSource {
  readonly activeName: string;
  listNames(): string[];
  switch(name: string, model?: string): LLMProvider;
  readonly active: LLMProvider;
}

export type FailoverListener = (from: string, to: string, error: Error) => void;

/** True when the error is worth failing over to another provider. */
export function isFailoverError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  // HTTP status, attached by openai-compat as a typed LlmError: retryable only.
  if (err instanceof LlmError && typeof err.llmStatus === "number") {
    return err.llmStatus === 429 || err.llmStatus >= 500;
  }
  // Network-level failures by errno-style code (Bun: "ConnectionRefused",
  // Node: "ECONNREFUSED", DNS: "ENOTFOUND"/"EAI_AGAIN", etc).
  const e = err as { code?: string; message?: string };
  const normCode = (e?.code ?? "").replace(/[-_]/g, "").toLowerCase();
  if (/^abort/.test(normCode)) return false;
  if (
    /conn(refused|reset|timedout)|enotfound|eai_again|namenotresolved/.test(normCode)
  ) {
    return true;
  }
  // Network-level failures by message (fetch failed, timeouts, socket resets).
  return /fetch failed|unable to connect|network|econnrefused|enotfound|etimedout|socket hang up|connection refused|connection reset/i.test(
    e?.message ?? "",
  );
}

/**
 * Wraps a FallbackSource so that retryable failures (429/5xx/network) on the
 * active provider transparently switch to the next configured entry and retry
 * there. Failover happens ONLY before any chunk was emitted — mid-stream
 * failures rethrow to avoid duplicated output. The last provider that served
 * a successful call becomes the new active entry (sticky).
 */
export class FallbackProvider implements LLMProvider {
  constructor(
    private source: FallbackSource,
    private onFailover?: FailoverListener,
  ) {}

  get model(): string {
    return this.source.active.model;
  }

  get contextWindow(): number {
    return this.source.active.contextWindow;
  }

  async *chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: ChatOptions,
  ): AsyncIterable<import("../../llm/provider").Chunk> {
    const names = this.source.listNames();
    if (names.length <= 1) {
      yield* this.source.active.chat(messages, tools, signal, options);
      return;
    }

    let emitted = false;
    let idx = Math.max(0, names.indexOf(this.source.activeName));
    let lastError: unknown;

    for (let attempt = 0; attempt < names.length; attempt++) {
      const name = names[idx];
      const provider = name === this.source.activeName
        ? this.source.active
        : this.source.switch(name);
      try {
        for await (const chunk of provider.chat(messages, tools, signal, options)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (err) {
        // Mid-stream failure after content was delivered: a restart would
        // duplicate chunks — surface the error instead of failing over.
        if (emitted || !isFailoverError(err)) throw err;
        lastError = err;
        idx = (idx + 1) % names.length;
        this.onFailover?.(name, names[idx], err as Error);
      }
    }
    throw lastError;
  }

  countTokens(text: string): number {
    return this.source.active.countTokens(text);
  }

  async listModels(): Promise<string[]> {
    return this.source.active.listModels();
  }
}
