/** Подсчёт токенов: точный (tiktoken) и дешёвая эвристика для блоков. */
import { createRequire } from "node:module";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import { getMessageText } from "./provider";
import type { ContentPart } from "./provider";

/**
 * Класс BPE-энкодинга модели (L6). `o200k` — OpenAI 4o/o1/o3/o4/4.1/5;
 * всё остальное (локальные, Anthropic — для него точного ранга в tiktoken
 * нет, cl100k здесь осознанное приближение) — `cl100k`.
 */
export type TokenEncoding = "cl100k" | "o200k";

const O200K_RE = /(gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|\bo[134](-mini|-preview)?\b)/i;

/** Энкодинг по имени модели; пустое/неизвестное — cl100k (статус-кво локали). */
export function encodingForModel(model: string | undefined): TokenEncoding {
  if (!model) return "cl100k";
  return O200K_RE.test(model) ? "o200k" : "cl100k";
}

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
 * Точный счётчик токенов (L6): энкодинг выбирается по имени модели, а не
 * захардкожен. `cl100k_base` (~1.1 MB) грузится всегда; `o200k_base` (~2.3 MB)
 * — лениво при первом подсчёте o200k-модели, чтобы локальные 9B не платили
 * за чужие ранги на каждом старте. Дефолт без модели — cl100k (статус-кво).
 */
export class TokenCounter {
  private encoder: Tiktoken | null = null;
  /** Выбранный энкодинг (для диагностики, какой линейкой считали). */
  readonly encoding: TokenEncoding;

  constructor(model?: string) {
    this.encoding = encodingForModel(model);
    if (this.encoding === "cl100k") {
      this.encoder = new Tiktoken(cl100k);
    }
  }

  private ensureEncoder(): Tiktoken {
    if (!this.encoder) {
      const require = createRequire(import.meta.url);
      const ranks = require("js-tiktoken/ranks/o200k_base").default ?? require("js-tiktoken/ranks/o200k_base");
      this.encoder = new Tiktoken(ranks as typeof cl100k);
    }
    return this.encoder;
  }

  /**
   * Считает токены текста.
   * @param text текст; @returns число токенов.
   */
  count(text: string): number {
    if (!text) return 0;
    return this.ensureEncoder().encode(text).length;
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
    return this.ensureEncoder().encode(text);
  }

  /**
   * Декодирует токены в текст.
   * @param tokens id токенов; @returns текст.
   */
  decode(tokens: number[]): string {
    return this.ensureEncoder().decode(tokens);
  }
}
