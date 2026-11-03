/**
 * Prompt-tag стратегия reasoning: тег дописывается в последнее user-сообщение
 * исходящей копии. Вынесено из `openai-compat.ts` (правило 6).
 */
import type { Message } from "./provider";

/** Дописывает тег в последнее user-сообщение (исходящая копия, не в контекст). */
export function applyPromptTag(messages: Message[], tag: string): Message[] {
  const copy = [...messages];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === "user") {
      const msg = { ...copy[i] };
      if (typeof msg.content === "string") {
        msg.content = `${msg.content}\n${tag}`;
      } else {
        // Массив частей — дописываем текстовую часть
        msg.content = [...msg.content, { type: "text" as const, text: tag }];
      }
      copy[i] = msg;
      break;
    }
  }
  return copy;
}
