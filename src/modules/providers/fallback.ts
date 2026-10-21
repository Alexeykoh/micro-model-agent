// Failover-обёртка: ретраируемые ошибки (429/5xx/сеть) переключают на следующий провайдер.
// src/modules/providers/fallback.ts
import type {
  ChatOptions,
  LLMProvider,
  Message,
  ToolDefinition,
} from "../../llm/provider";
import { LlmError } from "../../llm/llm-errors";

/**
 * Минимальная поверхность ProviderManager для failover-обёртки. Структурная
 * типизация позволяет тестам инжектить стаб без настоящего менеджера.
 */
export interface FallbackSource {
  readonly activeName: string;
  listNames(): string[];
  switch(name: string, model?: string): LLMProvider;
  /**
   * Модель, закреплённая за провайдером (из `provider.models`). Failover обязан
   * переключаться на модель ЦЕЛЕВОГО провайдера: модель прежнего у другого
   * провайдера обычно не существует (аудит §7.7).
   */
  modelFor?(name: string): string | undefined;
  readonly active: LLMProvider;
}

/** Колбэк переключения: с какого на какой и по какой ошибке. */
export type FailoverListener = (from: string, to: string, error: Error) => void;

/** Стоит ли ошибка переключения на другой провайдер. */
export function isFailoverError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  // HTTP-статус, прикреплённый openai-compat как типизированный LlmError: только ретраируемые.
  if (err instanceof LlmError && typeof err.llmStatus === "number") {
    // 404 «model not found» — тоже повод переключиться: у другого провайдера
    // своя модель (аудит §7.7).
    if (err.llmStatus === 404) return true;
    return err.llmStatus === 429 || err.llmStatus >= 500;
  }
  // Сетевые падения по errno-коду (Bun: "ConnectionRefused",
  // Node: "ECONNREFUSED", DNS: "ENOTFOUND"/"EAI_AGAIN" и т.д.).
  const e = err as { code?: string; message?: string };
  const normCode = (e?.code ?? "").replace(/[-_]/g, "").toLowerCase();
  if (/^abort/.test(normCode)) return false;
  if (
    /conn(refused|reset|timedout)|enotfound|eai_again|namenotresolved/.test(normCode)
  ) {
    return true;
  }
  // Сетевые падения по сообщению (fetch failed, таймауты, сбросы сокета).
  return /fetch failed|unable to connect|network|econnrefused|enotfound|etimedout|socket hang up|connection refused|connection reset/i.test(
    e?.message ?? "",
  );
}

/**
 * Оборачивает FallbackSource: ретраируемые падения (429/5xx/сеть) активного
 * провайдера прозрачно переключаются на следующую запись с ретраем там.
 * Failover — ТОЛЬКО до первого чанка: падение посреди стрима пробрасывается,
 * чтобы не дублировать вывод. Последний провайдер с успешным вызовом
 * становится активным (sticky).
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

  /** Лимит completion-токенов активного провайдера (INV-C5). */
  get maxCompletionTokens(): number | undefined {
    return this.source.active.maxCompletionTokens;
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
        : this.source.switch(name, this.source.modelFor?.(name));
      try {
        for await (const chunk of provider.chat(messages, tools, signal, options)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (err) {
        // Падение посреди стрима после отданного контента: рестарт
        // задублировал бы чанки — пробросить ошибку вместо failover.
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
