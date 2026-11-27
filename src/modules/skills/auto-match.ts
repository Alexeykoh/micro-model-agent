/**
 * Детерминированное сопоставление сообщения пользователя со скиллом (S14).
 *
 * Правила намеренно консервативные: считаем только точные совпадения токенов
 * из объявленных `keywords`, порог — два разных токена. Одно совпадение не
 * загружает скилл, чтобы не тащить в 9B-контекст случайный материал, а при
 * равном счёте двух скиллов не загружаем ни один (не угадываем за модель).
 *
 * Язык: токены unicode-букв/цифр, поэтому латинские термины в русском
 * сообщении (`git merge conflict`) совпадает так же, как в английском. Чисто
 * русские формулировки без терминов из `keywords` остаются за явным
 * `load_skill` — это честное ограничение, а не эвристика «на всякий случай».
 */
import type { SkillMeta } from "./loader";

const MIN_TOKEN_LEN = 3;
const MIN_HITS = 2;

/** Токены сообщения/ключа: только слова длиной ≥3, без пунктуации. */
function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= MIN_TOKEN_LEN));
}

/**
 * Лучший скилл по явным ключевым словам или `null`, если совпадения
 * недостаточно или лучших несколько.
 */
export function matchSkillByMessage(message: string, skills: SkillMeta[]): SkillMeta | null {
  const words = tokenize(message);
  if (words.size === 0) return null;

  let best: SkillMeta | null = null;
  let bestScore = 0;
  let tied = false;

  for (const skill of skills) {
    const keywords = new Set<string>();
    for (const keyword of skill.keywords) {
      for (const token of tokenize(keyword)) keywords.add(token);
    }
    let hits = 0;
    for (const keyword of keywords) {
      if (words.has(keyword)) hits++;
    }
    if (hits < MIN_HITS) continue;
    if (hits > bestScore) {
      best = skill;
      bestScore = hits;
      tied = false;
    } else if (hits === bestScore) {
      tied = true;
    }
  }

  return tied ? null : best;
}
