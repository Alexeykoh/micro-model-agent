/**
 * Простой TF-поиск по чанкам корпуса (INV-D4): без зависимостей и без стемминга.
 * Запрос делится на термы; счёт — число вхождений термов в текст чанка плюс
 * небольшой вес совпадений в секции/пути. Выдача ограничена top-N, сниппет
 * ограничен по символам. Честная пустая выдача — не ошибка.
 */
import type { DocEntry } from "./corpus";

/** Максимум попаданий в выдаче `document_find` (INV-D4). */
export const FIND_LIMIT = 20;

/** Потолок символов сниппета одного попадания (INV-D4). */
export const SNIPPET_CHARS = 240;

/** Одно попадание поиска: путь, секция, сниппет и счёт. */
export interface SearchHit {
  rel: string;
  section?: string;
  snippet: string;
  score: number;
}

/** Число вхождений подстроки (без перекрытий). */
function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Сниппет вокруг первого совпадения, ограниченный по символам (INV-D4). */
function snippetOf(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (pos === -1 || i < pos)) pos = i;
  }
  const start = pos > 40 ? pos - 40 : 0;
  const raw = text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, " ").trim();
  return raw.length > SNIPPET_CHARS ? raw.slice(0, SNIPPET_CHARS) : raw;
}

/**
 * Ищет чанки по запросу: case-insensitive TF по тексту + вес секции/пути.
 * Возвращает top-`limit` попаданий (score > 0), отсортированных по счёту.
 */
export function searchChunks(entries: DocEntry[], query: string, limit = FIND_LIMIT): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const relLower = entry.rel.toLowerCase();
    for (const chunk of entry.chunks) {
      const textLower = chunk.text.toLowerCase();
      const sectionLower = chunk.section?.toLowerCase() ?? "";
      let score = 0;
      for (const term of terms) {
        score += countOccurrences(textLower, term);
        if (sectionLower) score += 2 * countOccurrences(sectionLower, term);
        score += countOccurrences(relLower, term);
      }
      if (score > 0) {
        hits.push({ rel: entry.rel, section: chunk.section, snippet: snippetOf(chunk.text, terms), score });
      }
    }
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.rel.localeCompare(b.rel) ||
      (a.section ?? "").localeCompare(b.section ?? "") ||
      a.snippet.localeCompare(b.snippet),
  );
  return hits.slice(0, Math.max(0, limit));
}
