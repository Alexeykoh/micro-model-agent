/** Подсчёт токенов: точный (tiktoken) и дешёвая эвристика для блоков. */
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import { getMessageText } from "./provider";
import type { ContentPart } from "./provider";

/**
 * Скриптозависимая ОЦЕНКА токенов (дешёвая, без полной токенизации). Достаточно
 * дешёвая для каждого PromptBlock; на этапе сборки точного TokenCounter может
 * не быть в scope. Замерено на cl100k_base: латиница ~4 символа/токен, кириллица
 * ~2.5 символа/токен (плотнее латиницы), CJK/хангыль — выбросы ~1–1.5 токена/
 * символ. Держим оценку в пределах ±30% от точного cl100k-счётчика.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let cyr = 0;
  let rest = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x3000 && code <= 0x9fff) || // CJK unified + symbols
      (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
      (code >= 0xff00 && code <= 0xffef) // fullwidth forms
    ) {
      cjk++;
    } else if (code >= 0x0400 && code <= 0x052f) {
      cyr++;
    } else {
      rest++;
    }
  }
  return Math.ceil(cjk / 1.5 + cyr / 2.5 + rest / 4);
}

/**
 * Точный счётчик токенов поверх cl100k_base (единая rank-таблица, ~1.1 MB вместо
 * ~5.6 MB полного `js-tiktoken` со всеми таблицами). `cl100k_base` — тот же
 * энкодинг, в который и раньше уходил фолбэк для локальных моделей; модели
 * o200k-класса (OpenAI GPT-4o) считаются им же — расхождение в несколько процентов.
 */
export class TokenCounter {
  private encoder: Tiktoken;

  constructor(_model: string = "gpt-4o") {
    this.encoder = new Tiktoken(cl100k);
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
