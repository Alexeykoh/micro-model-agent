// src/llm/token-counter.ts
import { encodingForModel, getEncoding } from "js-tiktoken";
import { getMessageText } from "./provider";
import type { ContentPart } from "./provider";

/**
 * Script-aware token ESTIMATE (cheap, no full tokenization). Cheap enough for
 * every hand-built PromptBlock; used at block-build time where the exact
 * TokenCounter may not be in scope. Measured on cl100k_base: Latin AND
 * Cyrillic both encode at ~3.3-5 chars/token (the old flat len/4 was actually
 * close for Cyrillic — the "cyr ≈ /2" assumption was wrong); CJK/Hangul are
 * the real outliers at ~1-1.5 tokens/char, so they get /1.5. Within ±30% of
 * tiktoken for Russian text.
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

export class TokenCounter {
  private encoder: ReturnType<typeof getEncoding>;

  constructor(model: string = "gpt-4o") {
    try {
      this.encoder = encodingForModel(model as Parameters<typeof encodingForModel>[0]);
    } catch {
      // Fallback to cl100k_base for unknown models
      this.encoder = getEncoding("cl100k_base");
    }
  }

  count(text: string): number {
    if (!text) return 0;
    return this.encoder.encode(text).length;
  }

  countMessages(messages: Array<{ role: string; content: string | ContentPart[] }>): number {
    let total = 0;
    for (const msg of messages) {
      // ~4 tokens per message overhead (role, boundaries)
      total += 4;
      const text = getMessageText(msg.content);
      total += this.count(text);
      if (msg.role === "tool") total += 2; // tool_call_id
    }
    total += 2; // assistant priming
    return total;
  }

  encode(text: string): number[] {
    return this.encoder.encode(text);
  }

  decode(tokens: number[]): string {
    return this.encoder.decode(tokens);
  }
}
