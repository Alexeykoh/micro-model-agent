/**
 * Нормализация текста для детекции путей/машины (INV-D8): регистр и разделители
 * не влияют на вердикт. Позиции находок должны указывать на **исходную** строку,
 * поэтому нормализация — только для сопоставления, а не для подмены текста.
 */

/** Диапазон [start, end) в исходной строке. */
export type Range = [start: number, end: number];

/** Приводит путь к forward-slash и нижнему регистру (win32-safe). */
export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/** Есть ли пересечение диапазонов [aStart,aEnd) и [bStart,bEnd). */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Пересекается ли [start,end) хотя бы с одним диапазоном из `ranges`. */
export function overlapsAny(start: number, end: number, ranges: readonly Range[]): boolean {
  for (const [s, e] of ranges) {
    if (overlaps(start, end, s, e)) return true;
  }
  return false;
}

const URL_RE = /\b(?:[a-z][a-z0-9+.-]*):\/\/[^\s"'<>()[\]]+/gi;
const MAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

/**
 * Диапазоны URL и e-mail — их содержимое не трактуем как файловые пути
 * (`https://host/a/b` не должно ловиться как `/a/b`). URL вырезаются первыми (Q9).
 */
export function excludedRanges(text: string): Range[] {
  return rangesOf(text, [URL_RE, MAIL_RE]);
}

/**
 * Только URL-диапазоны: для PII e-mail — сама цель детекции, а не «исключение».
 * Использовать там, где e-mail не должен глушить находку.
 */
export function urlRanges(text: string): Range[] {
  return rangesOf(text, [URL_RE]);
}

/** Собрать диапазоны совпадений набора regex по исходному тексту. */
function rangesOf(text: string, regexes: readonly RegExp[]): Range[] {
  const ranges: Range[] = [];
  for (const re of regexes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

/** Найти все вхождения литерала `needle` (с учётом регистра) в `text`. */
export function findAll(text: string, needle: string): Range[] {
  const ranges: Range[] = [];
  if (!needle) return ranges;
  const hay = text.toLowerCase();
  const low = needle.toLowerCase();
  let idx = hay.indexOf(low);
  while (idx !== -1) {
    ranges.push([idx, idx + needle.length]);
    idx = hay.indexOf(low, idx + needle.length);
  }
  return ranges;
}
