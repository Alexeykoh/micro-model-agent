/**
 * Кэш оценки токенов по сообщению: сигнатура контента + пересчёт при её смене.
 *
 * Вынесено из `ContextManager` (правило 6). Сообщения считаются иммутабельными
 * после добавления, но защищаемся от in-place мутаций (поздний аттач картинок):
 * иначе оценка «вырастала на +44K при двух добавленных сообщениях».
 */
import type { Message } from "./message";
import type { TokenCounter } from "../../llm/token-counter";
import { estimateMessageTokens, messageSignature } from "./estimation";

/** Оценщик с кэшем по объекту сообщения. */
export class CachedTokenEstimator {
  private cache = new WeakMap<Message, { sig: string; tokens: number }>();

  /** Токены сообщения; пересчитывает при смене сигнатуры контента. */
  estimate(msg: Message, counter: TokenCounter | null = null): number {
    const sig = messageSignature(msg);
    const cached = this.cache.get(msg);
    if (cached !== undefined && cached.sig === sig) return cached.tokens;
    const tokens = estimateMessageTokens(msg, counter);
    this.cache.set(msg, { sig, tokens });
    return tokens;
  }
}
