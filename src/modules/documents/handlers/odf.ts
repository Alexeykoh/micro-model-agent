/**
 * ODF-слой поверх ZIP/OOXML (INV-D8): чтение `content.xml` пакета ODF (ods/odt)
 * и общие примитивы навигации/разбора таблиц `table:table`.
 *
 * Специфика форматов (таблицы ODS, текст ODT) живёт в своих обработчиках; здесь
 * только то, что делят оба. Все узлы приходят из `parseXml` (`ooxml.ts`), поэтому
 * одиночный узел и массив одноимённых нормализуются через `findAll`/`asArray`.
 */
import type { DocLimits } from "../handler";
import { attr, child, collectText, findAll, parseXml } from "./ooxml";
import { readZip, readZipText } from "./zip";

/** Предел материализуемых колонок (INV-D4): `table:number-columns-repeated` не раздувает сетку. */
const MAX_COLS = 256;

/** Корень `office:body` из разобранного `content.xml` (терпит flat-ODF `office:document`). */
export function odfBody(root: unknown): unknown {
  const doc = child(root, "office:document-content") ?? child(root, "office:document") ?? root;
  return child(doc, "office:body");
}

/** Разбирает `content.xml` пакета ODF; `undefined`, если части нет (INV-D5, без исключения). */
export function readOdfContent(bytes: Uint8Array): unknown {
  const zip = readZip(bytes);
  const text = readZipText(zip, "content.xml");
  return text === undefined ? undefined : parseXml(text);
}

/** Текст абзаца/заголовка ODF (`text:p`/`text:h`) — склейка всех текстовых узлов. */
export function odfText(node: unknown): string {
  return collectText(node).trim();
}

/** Имя `table:table` из `@_table:name`. */
export function odfTableName(node: unknown): string | undefined {
  return attr(node, "table:name");
}

/** Уровень `text:h` из `@_text:outline-level` (отсутствие/мусор → 1). */
export function odfHeadingLevel(node: unknown): number {
  const raw = attr(node, "text:outline-level");
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Пункты `text:list`: текст `text:list-header`/`text:p` каждого `text:list-item`.
 * Вложенные списки (`text:list` внутри пункта) не разворачиваются — только
 * собственные абзацы пункта (граница простоты).
 */
export function odfListItems(list: unknown): string[] {
  const items: string[] = [];
  for (const item of findAll(list, "text:list-item")) {
    const parts = [...findAll(item, "text:list-header"), ...findAll(item, "text:p")]
      .map(odfText)
      .filter((s) => s !== "");
    if (parts.length) items.push(parts.join("\n"));
  }
  return items;
}

/** Таблица ODF: имя + заголовок (первая строка) + строки данных. */
export interface OdfTable {
  name?: string;
  header: string[];
  rows: string[][];
  /** Строка/колонка отброшены по лимиту (INV-D4). */
  truncated?: boolean;
}

/** Количество повторов `table:number-*-repeated` (отсутствие/мусор → 1). */
function repeatCount(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Текст ячейки: абзацы `text:p` через перевод строки. */
function cellText(cell: unknown): string {
  return findAll(cell, "text:p")
    .map(odfText)
    .filter((s) => s !== "")
    .join("\n");
}

/** Ячейки строки с учётом `table:number-columns-repeated` (не более `maxCols`). */
function rowCells(row: unknown, maxCols: number): { cells: string[]; truncated: boolean } {
  const cells: string[] = [];
  let truncated = false;
  for (const cell of findAll(row, "table:table-cell")) {
    if (truncated) break;
    const repeat = repeatCount(attr(cell, "table:number-columns-repeated"));
    const value = cellText(cell);
    for (let i = 0; i < repeat; i++) {
      if (cells.length >= maxCols) {
        truncated = true;
        break;
      }
      cells.push(value);
    }
  }
  return { cells, truncated };
}

/**
 * Разбирает `table:table` в таблицу: строк до `maxTableRows` (плюс заголовок),
 * колонок до `MAX_COLS`; превышение → `truncated`. Повторы строк/колонок
 * разворачиваются, но ограничиваются во время разбора (INV-D4), а не после.
 */
export function readOdfTable(node: unknown, limits: DocLimits): OdfTable {
  const rowCap = limits.maxTableRows + 1; // заголовок + строки данных
  const grid: string[][] = [];
  let truncated = false;
  for (const row of findAll(node, "table:table-row")) {
    const { cells, truncated: cellTrunc } = rowCells(row, MAX_COLS);
    if (cellTrunc) truncated = true;
    const repeat = repeatCount(attr(row, "table:number-rows-repeated"));
    for (let r = 0; r < repeat; r++) {
      if (grid.length >= rowCap) {
        truncated = true;
        break;
      }
      grid.push([...cells]);
    }
  }
  const header = grid.shift() ?? [];
  return {
    name: odfTableName(node),
    header,
    rows: grid,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Строка таблицы содержит хотя бы одну непустую ячейку (иначе пустой лист, INV-D5). */
export function odfTableHasContent(table: OdfTable): boolean {
  return table.header.some((v) => v !== "") || table.rows.some((r) => r.some((v) => v !== ""));
}

