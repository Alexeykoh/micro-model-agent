// Декоратор провайдера: дефолтный потолок completion-токенов на вызов.
//
// Нужен там, где бюджет ответа задаёт вызывающий (субагент с `max_tokens`),
// а провайдер по умолчанию шлёт свой лимит.
import type { ChatOptions, Chunk, LLMProvider, Message, ToolDefinition } from "./provider";

/** Настройки декоратора. */
export interface TokenCapOptions {
  /**
   * Потолок для ЯВНОГО `options.maxTokens`, если вызывающий попросил больше
   * дефолта. Нужен петле: при обрыве до ответа она один раз повторяет запрос с
   * удвоенным бюджетом (спека `2026-10-27-subagent-reliability-design` §B.3).
   * Не задан — явный лимит клампится вниз, как раньше.
   */
  maxExplicit?: number;
}

/**
 * Провайдер, у которого каждый вызов `chat` ограничен по completion-токенам.
 * Если вызывающий не задал лимит — подставляется `cap`. Явный лимит меньше
 * `cap` сохраняется (не повышаем), больше — проходит до `maxExplicit`.
 */
export function withTokenCap(
  provider: LLMProvider,
  cap: number,
  opts: TokenCapOptions = {},
): LLMProvider {
  const explicitCeiling = Math.max(opts.maxExplicit ?? cap, cap);
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
        options?.maxTokens === undefined
          ? cap
          : Math.min(Math.max(options.maxTokens, 1), explicitCeiling);
      return provider.chat(messages, tools, signal, { ...options, maxTokens });
    },
  };
}
