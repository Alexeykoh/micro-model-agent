/**
 * Реестр языков и извлечение символов для индекса проекта.
 *
 * Новый язык = одна запись в `RULES` + одно или больше расширений в
 * `EXT_TO_LANGUAGE`. Каждое правило объявляет, код ли это (для ранжирования
 * карты) и как тянуть публичные/экспортные имена из файла. Извлечение
 * regex-based осознанно (без зависимости от парсера): дёшево, гоняется на
 * каждом индексируемом файле, и структуры хватает для полезности карты —
 * полный AST не нужен.
 *
 * Помимо имени символ несёт номер строки и `kind` (`function`/`class`/…) —
 * этого достаточно для `outline` и `find_symbol` без чтения файла.
 */

/** Кап на файл: один генерированный файл не раздувает карту. */
export {
  MAX_SIGNATURE_CHARS,
  MAX_SYMBOLS_PER_FILE,
  type SymbolLocation,
} from "./symbols-types";
export {
  languageIdForExt,
  isCodeLanguage,
  indexedExtensions,
  extractSymbolsDetailed,
  extractSymbols,
} from "./symbols-languages";

/** Паттерны спецификаторов импорта (TS/JS/Python/Rust/Ruby/PHP). */
const IMPORT_PATTERNS: RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(?\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  /^\s*use\s+([A-Za-z_][\w:]*)/gm,
  /^\s*#include\s+["<]([^">]+)[">]/gm,
];

/**
 * Извлекает сырые спецификаторы импорта/require из содержимого. Используется
 * графом ссылок (PageRank): резолв локальных путей — в `graph.ts`. Дубликаты
 * убираются, порядок — первый.
 */
export function extractImports(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const spec = match[1];
      if (spec && !seen.has(spec)) {
        seen.add(spec);
        out.push(spec);
      }
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}
