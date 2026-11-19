import type { ChatOptions, Chunk, LLMProvider, Message, ToolDefinition } from "../../src/llm/provider";

/**
 * Провайдер для тестов, который ЗАПИСЫВАЕТ опции каждого вызова по умолчанию
 * (W3.4). Без общего хелпера каждый тест лепит свой LLMProvider кастом и
 * забывает записать `ChatOptions` — тогда «стратегия/уровень дошли до вызова»
 * негде проверить. Здесь `calls` — всегда доступный факт, а не опция теста.
 */
export interface RecordedCall {
  messages: Message[];
  options?: ChatOptions;
}

export interface RecordingProvider extends LLMProvider {
  calls: RecordedCall[];
}

/**
 * @param respond возвращает текст (одна text-чанка) или готовые чанки; может
 *                бросить — тогда `chat` бросит (транзиентная ошибка в тестах).
 */
export function recordingProvider(
  respond: (call: RecordedCall, index: number) => string | Chunk[],
): RecordingProvider {
  const calls: RecordedCall[] = [];
  return {
    model: "fake",
    contextWindow: 32768,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    listModels: async () => [],
    calls,
    async *chat(
      messages: Message[],
      _tools?: ToolDefinition[],
      _signal?: AbortSignal,
      options?: ChatOptions,
    ): AsyncIterable<Chunk> {
      const call: RecordedCall = { messages, options };
      calls.push(call);
      const out = respond(call, calls.length - 1);
      if (typeof out === "string") {
        yield { type: "text", content: out };
        return;
      }
      for (const chunk of out) yield chunk;
    },
  };
}
