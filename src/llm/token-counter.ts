/** Подсчёт токенов: точный (tiktoken) и дешёвая эвристика для блоков. */
import { encodingForModel, getEncoding } from "js-tiktoken";
import { getMessageText } from "./provider";
import type { ContentPart } from "./provider";

/**
 * Скриптозависимая ОЦЕНКА токенов (дешёвая, без полной токенизации). Достаточно
 * дешёвая для каждого PromptBlock; на этапе сборки точного TokenCounter может
 * не быть в scope. Замерено на cl100k_base: латиница И кириллица — ~3.3–5
 * символов/токен (старый плоский len/4 для кириллицы был почти верен —
 * гипотеза «кириллица ≈ /2» ошибочна); CJK/хангыль — выбросы ~1–1.5 токена/
 * символ, им /1.5. В пределах ±30% от tiktoken на русском.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x3000 && code <= 0x9fff) || // CJK unified + symbols
      (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
      (code >= 0xff00 && code <= 0xffef) // fullwidth forms
    ) {
      cjk++;
    } else {
      rest++;
    }
  }
  return Math.ceil(cjk / 1.5 + rest / 4);
}

/** Точный счётчик токенов поверх tiktoken (энкодинг по модели). */
export class TokenCounter {
  private encoder: ReturnType<typeof getEncoding>;

  constructor(model: string = "gpt-4o") {
    try {
      this.encoder = encodingForModel(model as Parameters<typeof encodingForModel>[0]);
    } catch {
      // Фолбэк на cl100k_base для неизвестных моделей
      this.encoder = getEncoding("cl100k_base");
    }
  }

  /**
   * Считает токены текста.
   * @param text текст; @returns число токенов.
   */
  count(text: string): number {
    if (!text) return 0;
    return this.encoder.encode(text).length;
  }

  /**
   * Считает токены сообщений с оверхедом ролей/границ (~4/сообщение).
   * @param messages сообщения чата; @returns суммарные токены.
   */
  countMessages(messages: Array<{ role: string; content: string | ContentPart[] }>): number {
    let total = 0;
    for (const msg of messages) {
      // ~4 токена оверхеда на сообщение (роль, границы)
      total += 4;
      const text = getMessageText(msg.content);
      total += this.count(text);
      if (msg.role === "tool") total += 2; // tool_call_id
    }
    total += 2; // прайминг ассистента
    return total;
  }

  /**
   * Кодирует текст в токены.
   * @param text текст; @returns массив id токенов.
   */
  encode(text: string): number[] {
    return this.encoder.encode(text);
  }

  /**
   * Декодирует токены в текст.
   * @param tokens id токенов; @returns текст.
   */
  decode(tokens: number[]): string {
    return this.encoder.decode(tokens);
  }
}
