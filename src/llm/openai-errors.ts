/**
 * Классификация ошибок OpenAI-совместимого провайдера по телу ответа.
 * Вынесено из `openai-compat.ts` (правило 6).
 */

/** Классификатор ошибок провайдера по телу: `"context_length"` только при явном
 *  превышении контекста, иначе `undefined` (fail-open — неверная классификация
 *  ведёт к агрессивному поведению). */
export function classifyProviderError(errorText: string): string | undefined {
  if (!errorText) return undefined;
  const re =
    /(context (?:length|window|size)|maximum context|max(?:imum)? (?:number of )?tokens|too many tokens|input is too long|prompt is too long|reduce the length|exceed[s]? .{0,30}context)/i;
  return re.test(errorText) ? "context_length" : undefined;
}
