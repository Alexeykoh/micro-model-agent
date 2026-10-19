/**
 * Тег класса `file-content` (спека §4.8). Результат тула, прочитавшего путь под
 * `providerBlockGlobs`, помечается sentinel'ом: guard на egress снимает тег для
 * доверенного (локального) провайдера и заменяет **всё** содержимое маской для
 * внешнего/API — независимо от PII-паттернов.
 *
 * Тег живёт в самой строке, поэтому переживает клонирование сообщений
 * (`repairToolCallPairing`), компакцию и resume из `session.jsonl`.
 *
 * DEBT(file-content-taint): доверенный провайдер видит содержимое, и его
 * производный текст/сводка компакции тега уже не несут.
 */
export const FILE_CONTENT_SENTINEL = "⟦mma:file-content⟧\n";

/** Пометить содержимое как file-content. */
export function tagFileContent(content: string): string {
  return content.startsWith(FILE_CONTENT_SENTINEL)
    ? content
    : FILE_CONTENT_SENTINEL + content;
}

/** Строка помечена как file-content? */
export function isTaggedFileContent(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(FILE_CONTENT_SENTINEL);
}

/** Снять тег (для доверенного egress). */
export function untagFileContent(value: string): string {
  return value.slice(FILE_CONTENT_SENTINEL.length);
}
