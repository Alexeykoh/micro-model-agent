// Декоратор провайдера: жёсткий кап completion-токенов на каждый вызов.
//
// Нужен там, где бюджет ответа задаёт вызывающий (субагент с `max_tokens`),
// а провайдер по умолчанию шлёт свой лимит.
import type { ChatOptions, Chunk, LLMProvider, Message, ToolDefinition } from "./provider";

/**
 * Провайдер, у которого каждый вызов `chat` ограничен по completion-токенам.
 * Если вызывающий задал меньший лимит — он не увеличивается.
 */
export function withTokenCap(provider: LLMProvider, cap: number): LLMProvider {
  return {
    get model(): string {
      return provider.model;
    },
    get contextWindow(): number {
      return provider.contextWindow;
    },
    get maxCompletionTokens(): number | undefined {
      return provider.maxCompletionTokens;
    },
    countTokens: (text: string) => provider.countTokens(text),
    listModels: () => provider.listModels(),
    chat: (
      messages: Message[],
      tools?: ToolDefinition[],
      signal?: AbortSignal,
      options?: ChatOptions,
    ): AsyncIterable<Chunk> => {
      const maxTokens =
        options?.maxTokens !== undefined ? Math.min(options.maxTokens, cap) : cap;
      return provider.chat(messages, tools, signal, { ...options, maxTokens });
    },
  };
}
