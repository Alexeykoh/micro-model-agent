/**
 * Декораторы спанов `gen_ai.*` (P0 observability 1/2): `llm.chat` поверх
 * LLMProvider и `tool.call` поверх ToolExecutor. Тонкие обёртки — поведение
 * и ошибки те же, fail-open (спаны never роняют вызов).
 */
import type { LLMProvider, Message, ToolDefinition, ChatOptions, Chunk } from "../../llm/provider";
import type { ToolExecutor } from "../../tools/executor";
import type { ToolCall } from "../../tools/types";
import { getOtelAdapter } from "./adapter";

/** Декоратор LLMProvider: спан `llm.chat` + метрики токенов. */
export class OtelProvider implements LLMProvider {
  constructor(private readonly inner: LLMProvider) {}

  get model(): string {
    return this.inner.model;
  }
  get contextWindow(): number {
    return this.inner.contextWindow;
  }
  get maxCompletionTokens(): number | undefined {
    return this.inner.maxCompletionTokens;
  }

  async *chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: ChatOptions,
  ): AsyncIterable<Chunk> {
    const adapter = getOtelAdapter();
    const span = adapter.startSpan("llm.chat", {
      "gen_ai.provider.name": "mma",
      "gen_ai.request.model": this.model,
      "gen_ai.system": "mma",
    });
    let promptTokens = 0;
    let completionTokens = 0;
    let failed = false;
    try {
      for await (const chunk of this.inner.chat(messages, tools, signal, options)) {
        if (chunk.usage) {
          promptTokens = chunk.usage.promptTokens ?? promptTokens;
          completionTokens = chunk.usage.completionTokens ?? completionTokens;
        }
        yield chunk;
      }
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      await span.ended(failed ? "error" : "ok", {
        "gen_ai.usage.input_tokens": promptTokens,
        "gen_ai.usage.output_tokens": completionTokens,
      });
      adapter.incMetric("llm.chats", 1, failed ? { result: "failed" } : { result: "ok" });
    }
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels();
  }
}

/** Декоратор ToolExecutor: спан `tool.call` + denied-метрика. */
export function wrapExecutorWithOtel<T extends ToolExecutor>(inner: T): T {
  const adapter = getOtelAdapter();
  const origExecute = inner.execute.bind(inner);
  const wrapped = new Proxy(inner, {
    get(target, prop) {
      if (prop === "fork") {
        return () => wrapExecutorWithOtel((target as unknown as { fork(): ToolExecutor }).fork());
      }
      if (prop === "execute") {
        return async (call: ToolCall, signal?: AbortSignal) => {
          const span = adapter.startSpan("tool.call", {
            "gen_ai.tool.name": call.name,
            "gen_ai.system": "mma",
          });
          try {
            const result = await origExecute(call, signal);
            adapter.incMetric("tool.execute", 1, {
              tool: call.name,
              result: result.success ? "ok" : "failed",
            });
            if (result.blocked) {
              adapter.incMetric("executor.denied", 1, { tool: call.name, kind: "blocked" });
            }
            await span.ended(result.success ? "ok" : "error", {
              "gen_ai.tool.success": result.success,
            });
            return result;
          } catch (err) {
            await span.ended("error", {
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? (value as (...a: never[]) => unknown).bind(target) : value;
    },
  });
  return wrapped as T;
}
