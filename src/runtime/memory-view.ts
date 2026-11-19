/**
 * Представление памяти для wire/REST (split W4b-2b): категории и разбор
 * append-only markdown. Общее для web и host wire.
 */

/** Кап одной записи памяти (символы): факт, а не дамп (аудит §6.5). */
export const MAX_MEMORY_ENTRY_CHARS = 20_000;

/** Append-only категории памяти (зеркало `MemoryStore`). */
export const MEMORY_CATEGORIES = ["conventions", "decisions", "errors", "facts"] as const;

/** Категория памяти. */
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** True, если строка — известная категория. */
export function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

/** Запись памяти: номер и текст. */
export interface MemoryEntry {
  n: number;
  text: string;
}

/** Режет append-only файл категории на записи с нумерацией от 1 (`- `-блоки). */
export function listEntries(markdown: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("- ")) entries.push({ n: entries.length + 1, text: line });
  }
  return entries;
}
