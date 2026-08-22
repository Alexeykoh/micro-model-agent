// src/modules/providers/fallback.ts
import type {
  ChatOptions,
  LLMProvider,
  Message,
  ToolDefinition,
} from "../../llm/provider";

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
  const e = err as { name?: string; llmStatus?: number; message?: string };
  if (e?.name === "AbortError") return false;
  // HTTP status attached by openai-compat: retryable statuses only.
  if (typeof e?.llmStatus === "number") return e.llmStatus === 429 || e.llmStatus >= 500;
  // Network-level failures (fetch failed, connection refused, DNS, timeouts).
  return /fetch failed|network|econnrefused|enotfound|etimedout|socket hang up/i.test(
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
