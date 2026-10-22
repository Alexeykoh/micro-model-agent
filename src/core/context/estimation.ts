/**
 * Оценка токенов сообщения: сигнатура содержимого и сам подсчёт.
 *
 * Вынесено из `ContextManager` (правило 6): чистые функции без состояния
 * менеджера. Токены картинок считаются по пикселям (§3.4 аудита), а не по
 * длине base64.
 */
import type { Message } from "./message";
import { getMessageText } from "../../llm/provider";
import type { TokenCounter } from "../../llm/token-counter";
import { imageTokensForDataUrl } from "../../llm/image-utils";

/** Дешёвая сигнатура содержимого сообщения (детект мутации без токенизации). */
export function messageSignature(m: Message): string {
  const text = typeof m.content === "string" ? m.content : getMessageText(m.content);
  const parts = Array.isArray(m.content)
    ? m.content
        .map((p) => (p.type === "image_url" ? `i:${p.image_url?.url?.length ?? 0}` : "t"))
        .join(",")
    : "s";
  const tc = m.tool_calls
    ? m.tool_calls.map((t) => `${t.id}:${t.function.name}:${t.function.arguments.length}`).join("|")
    : "";
  return `${m.role}${text.length}${parts}${tc}`;
}

/** Оценка токенов сообщения (с токен-каунтером — по-настоящему, иначе ~2 симв/токен). */
export function estimateMessageTokens(m: Message, tokenCounter: TokenCounter | null): number {
  const text = getMessageText(m.content);
  if (tokenCounter) {
    let t = tokenCounter.count(text);
    // Токены картинок: по пикселям (тайл 512×512 ≈ 130 токенов).
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "image_url" && part.image_url?.url) {
          t += imageTokensForDataUrl(part.image_url.url);
        }
      }
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        t += tokenCounter.count(tc.id);
        t += tokenCounter.count(tc.function.name);
        t += tokenCounter.count(tc.function.arguments);
        t += 4;
      }
    }
    return t;
  }
  let t = Math.ceil(text.length / 2);
  if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part.type === "image_url" && part.image_url?.url) {
        t += imageTokensForDataUrl(part.image_url.url);
      }
    }
  }
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      t += Math.ceil(tc.id.length / 2);
      t += Math.ceil(tc.function.name.length / 2);
      t += Math.ceil(tc.function.arguments.length / 2);
      t += 4;
    }
  }
  return t;
}
