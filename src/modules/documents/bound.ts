/**
 * Ограничители вывода (INV-D4): любой текст/таблица, попадающие в контекст,
 * проходят через явное усечение с видимым маркером.
 */
import type { DocLimits } from "./handler";
import type { DocTable } from "./ir";

export const DEFAULT_DOC_LIMITS: DocLimits = { maxLines: 400, maxChars: 24_000, maxTableRows: 50 };

/** Обрезает текст до maxLines/maxChars с явным маркером (INV-D4). */
export function boundText(text: string, limits: DocLimits): string {
  let lines = text.split("\n");
  let marker = "";
  if (lines.length > limits.maxLines) {
    marker = `\n[...truncated ${lines.length - limits.maxLines} lines...]`;
    lines = lines.slice(0, limits.maxLines);
  }
  let out = lines.join("\n") + marker;
  if (out.length > limits.maxChars) {
    out = `${out.slice(0, limits.maxChars)}\n[...truncated to ${limits.maxChars} chars...]`;
  }
  return out;
}

/** Обрезает однострочный текст (заголовок) до maxChars с маркером (INV-D4). */
export function boundLine(text: string, limits: DocLimits): string {
  if (text.length <= limits.maxChars) return text;
  return `${text.slice(0, limits.maxChars)}[...truncated to ${limits.maxChars} chars...]`;
}

/** Обрезает таблицу по числу строк, выставляя truncated (INV-D4). */
export function boundTable(table: DocTable, limits: DocLimits): DocTable {
  if (table.rows.length <= limits.maxTableRows) return table;
  return { ...table, rows: table.rows.slice(0, limits.maxTableRows), truncated: true };
}
