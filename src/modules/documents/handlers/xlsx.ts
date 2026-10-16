/**
 * XLSX/XLSM → `DocumentIR` (группа spreadsheet, INV-D2/D5).
 *
 * Имена и порядок листов — из `xl/workbook.xml`; связь rId→часть — из
 * `xl/_rels/workbook.xml.rels`. Первая строка листа — заголовок таблицы.
 * На каждый лист: блок-таблица + узел outline (`kind:"sheet"`). Нет worksheet-
 * частей → `meta.degraded`, без исключения (INV-D5). Политику не реализует (INV-D6).
 */
import { boundTable } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR, type DocumentIR, type DocTable } from "../ir";
import { asArray, attr, collectText, readOoxml, textOf } from "./ooxml";

/** Значение поля дочернего узла или `undefined`. */
function child(node: unknown, key: string): unknown {
  if (node === null || typeof node !== "object") return undefined;
  return (node as Record<string, unknown>)[key];
}

/** A→0, B→1, …, Z→25, AA→26 (берёт буквенную часть ссылки ячейки). */
export function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.toUpperCase();
    if (c < "A" || c > "Z") break;
    n = n * 26 + (c.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** 0→"A", 25→"Z", 26→"AA" (обратно `colIndex`). */
function colName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Значение ячейки: shared-string по `t="s"`, inlineStr, иначе текстовый узел `<v>`. */
function cellValue(cell: unknown, shared: string[]): string {
  const t = attr(cell, "t");
  if (t === "s") return shared[Number(textOf(child(cell, "v")))] ?? "";
  if (t === "inlineStr") return collectText(child(cell, "is"));
  return textOf(child(cell, "v"));
}

/** Список sharedStrings: каждый `<si>` — склейка текстовых ранов. */
function readShared(xml: unknown): string[] {
  return asArray(child(child(xml, "sst"), "si")).map(collectText);
}

/** Лист книги: имя + rId связи на часть. */
interface SheetRef {
  name: string;
  rid?: string;
}

/** Имена и порядок листов из `workbook.xml`. */
function sheetRefs(doc: unknown): SheetRef[] {
  const sheetsNode = child(child(doc, "workbook"), "sheets");
  return asArray(child(sheetsNode, "sheet")).map((s) => {
    const name = attr(s, "name") ?? "";
    const rid = attr(s, "r:id");
    return rid ? { name, rid } : { name };
  });
}

/** Карта `rId → Target` из файла связей. */
function relTargets(doc: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of asArray(child(child(doc, "Relationships"), "Relationship"))) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

/** Target из rels задан относительно `xl/` (или абсолютным путём от корня пакета). */
function resolveTarget(target: string): string {
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
}

/**
 * Часть листа: по rId→rels, иначе фолбэк `xl/worksheets/sheet{N}.xml` по порядку.
 * Фолбэк — известное ограничение: имя части может не совпадать со сдвигом в книге,
 * но для типовых книг (порядок sheet1…sheetN) этого достаточно.
 */
function sheetTarget(rid: string | undefined, rels: Map<string, string>, index: number): string {
  const target = rid ? rels.get(rid) : undefined;
  return target ? resolveTarget(target) : `xl/worksheets/sheet${index + 1}.xml`;
}

/** Прямоугольная таблица листа: заголовок (первая строка), строки, диапазон. */
interface SheetGrid {
  header: string[];
  rows: string[][];
  range?: string;
}

/** Разбирает `<sheetData>` в прямоугольную сетку; пропуски → "". */
function readSheet(xml: unknown, shared: string[]): SheetGrid {
  const rowNodes = asArray(child(child(child(xml, "worksheet"), "sheetData"), "row"));
  const grid: string[][] = [];
  let maxCol = -1;
  let maxRow = -1;
  rowNodes.forEach((rowNode, fallback) => {
    const rowAttr = attr(rowNode, "r");
    const r = rowAttr ? Number(rowAttr) - 1 : fallback;
    let autoCol = 0;
    const rowArr: string[] = [];
    for (const cell of asArray(child(rowNode, "c"))) {
      const ref = attr(cell, "r");
      const c = ref ? colIndex(ref) : autoCol;
      autoCol = c + 1;
      rowArr[c] = cellValue(cell, shared);
      if (c > maxCol) maxCol = c;
    }
    grid[r] = rowArr;
    if (r > maxRow) maxRow = r;
  });
  if (maxRow < 0 || maxCol < 0) return { header: [], rows: [] };
  const norm: string[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const src = grid[r] ?? [];
    const out: string[] = [];
    for (let c = 0; c <= maxCol; c++) out.push(src[c] ?? "");
    norm.push(out);
  }
  return {
    header: norm.shift() ?? [],
    rows: norm,
    range: `A1:${colName(maxCol)}${maxRow + 1}`,
  };
}

/** Обработчик XLSX/XLSM (группа spreadsheet). */
export const xlsxHandler: DocumentHandler = {
  id: "xlsx",
  group: "spreadsheet",
  extensions: [".xlsx", ".xlsm"],
  mediaTypes: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
  ],
  detect: (h) => detectHead(h) === "zip",
  async parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR> {
    const bytes = await source.bytes();
    const ir = emptyIR("xlsx", bytes.length);
    ir.meta.title = source.display;
    const ooxml = readOoxml(bytes);
    const refs = sheetRefs(ooxml.xml("xl/workbook.xml"));
    ir.meta.sheets = refs.map((r) => r.name);
    const rels = relTargets(ooxml.xml("xl/_rels/workbook.xml.rels"));
    const shared = readShared(ooxml.xml("xl/sharedStrings.xml"));

    let found = 0;
    refs.forEach((ref, i) => {
      const xml = ooxml.xml(sheetTarget(ref.rid, rels, i));
      if (xml === undefined) return;
      found++;
      const grid = readSheet(xml, shared);
      ir.outline.push({ id: `sheet:${ref.name}`, level: 1, title: ref.name, kind: "sheet" });
      const table: DocTable = boundTable(
        { caption: ref.name, header: grid.header, rows: grid.rows, range: grid.range },
        ctx.limits,
      );
      ir.blocks.push({ kind: "table", table });
    });
    if (found === 0) ir.meta.degraded = { reason: "в книге нет worksheet-частей" };
    return ir;
  },
};
