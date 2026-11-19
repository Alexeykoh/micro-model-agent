/**
 * Тег класса `file-content` (спека §4.8). Результат тула, прочитавшего путь под
 * `providerBlockGlobs`, помечается sentinel'ом: guard на egress снимает тег для
 * доверенного (локального) провайдера и заменяет **всё** содержимое маской для
 * внешнего/API — независимо от PII-паттернов.
 *
 * Тег живёт в самой строке, поэтому переживает клонирование сообщений
 * (`repairToolCallPairing`), компакцию и resume из `session.jsonl`.
 *
 * Производный текст (ответ/сводка) отслеживается taint'ом контекста (T1–T5
 * спеки `2026-11-02-local-provider-taint-design.md`).
 */
export const FILE_CONTENT_SENTINEL = "⟦mma:file-content⟧\n";

/** Маска, которой заменяется tainted-сообщение на внешнем egress. */
export const FILE_CONTENT_MASK = "[FILE]";

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

/**
 * Текст защищённого содержимого для **производных каналов** (дайджест тула,
 * события критика, evidence галлюцинаций): `[FILE]` вместо оригинала.
 * Живой прогон показал утечку: `role:"tool"` маскировался, а копия в
 * `<system-summary>[Tool: …]` уходила внешнему провайдеру открытой.
 */
export function visibleFileContent(value: string, cap?: number): string {
  if (isTaggedFileContent(value)) return FILE_CONTENT_MASK;
  return cap === undefined ? value : value.slice(0, cap);
}
