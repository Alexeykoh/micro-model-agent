/**
 * Минимальные пакеты ODF (ODS/ODT) для тестов (не под `src/`).
 *
 * Собирает детерминированный ZIP с `content.xml` (и `mimetype`): обработчики ODF
 * читают только `content.xml`, поэтому остальные части (styles/meta/manifest) не
 * нужны. Форма `office:body` — как в реальных документах.
 */
import { buildZip } from "./fixtures-zip";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface OdfBuildOptions {
  /** true → все записи архива методом 8 (deflate). */
  deflate?: boolean;
  /** true → не создавать `content.xml` (проверка отсутствующей части, INV-D5). */
  skipContent?: boolean;
}

/** Собирает пакет ODF из готового тела `office:body` (внутренний хелпер). */
function buildOdfPackage(mime: string, bodyXml: string, opts: OdfBuildOptions): Uint8Array {
  const content =
    `${XML_HEAD}<office:document-content ${NS} office:version="1.3">` +
    `<office:body>${bodyXml}</office:body></office:document-content>`;
  const entries = [
    { name: "mimetype", data: mime },
    ...(opts.skipContent ? [] : [{ name: "content.xml", data: content, deflate: opts.deflate }]),
  ];
  return buildZip(entries);
}

export interface OdfCell {
  /** Текст ячейки (один `text:p`); отсутствие → пустая ячейка. */
  text?: string;
  /** `table:number-columns-repeated` (повтор ячейки). */
  colsRepeated?: number;
}

export interface OdfRow {
  cells: OdfCell[];
  /** `table:number-rows-repeated` (повтор строки). */
  rowsRepeated?: number;
}

export interface OdfTableSpec {
  name?: string;
  /** Строки внутри `table:table-header-rows` (форма заголовка LibreOffice). */
  headerRows?: OdfRow[];
  rows: OdfRow[];
  /** Обернуть строки тела в `table:table-rows`. */
  wrapBody?: boolean;
  /** Обернуть всё тело (шапку и строки) в `table:table-row-group`. */
  wrapAll?: boolean;
}

const cellXml = (cell: OdfCell): string => {
  const repeat = cell.colsRepeated ? ` table:number-columns-repeated="${cell.colsRepeated}"` : "";
  const inner = cell.text === undefined ? "" : `<text:p>${escapeXml(cell.text)}</text:p>`;
  return `<table:table-cell${repeat}>${inner}</table:table-cell>`;
};

const rowXml = (row: OdfRow): string => {
  const repeat = row.rowsRepeated ? ` table:number-rows-repeated="${row.rowsRepeated}"` : "";
  return `<table:table-row${repeat}>${row.cells.map(cellXml).join("")}</table:table-row>`;
};

/** Собирает ODS: таблицы `table:table` внутри `office:spreadsheet`. */
export function buildOds(tables: OdfTableSpec[], opts: OdfBuildOptions = {}): Uint8Array {
  const tablesXml = tables
    .map((t) => {
      const name = t.name ? ` table:name="${escapeXml(t.name)}"` : "";
      const header = t.headerRows?.length
        ? `<table:table-header-rows>${t.headerRows.map(rowXml).join("")}</table:table-header-rows>`
        : "";
      const body = t.rows.map(rowXml).join("");
      const withBody = t.wrapBody ? `<table:table-rows>${body}</table:table-rows>` : body;
      const inner = t.wrapAll
        ? `<table:table-row-group>${header}${withBody}</table:table-row-group>`
        : header + withBody;
      return `<table:table${name}>${inner}</table:table>`;
    })
    .join("");
  return buildOdfPackage(
    "application/vnd.oasis.opendocument.spreadsheet",
    `<office:spreadsheet>${tablesXml}</office:spreadsheet>`,
    opts,
  );
}

export type OdtItem =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; name?: string; rows: Array<Array<string | OdfCell>> };

const odtItemXml = (item: OdtItem): string => {
  if (item.kind === "h") {
    return `<text:h text:outline-level="${item.level}">${escapeXml(item.text)}</text:h>`;
  }
  if (item.kind === "p") return `<text:p>${escapeXml(item.text)}</text:p>`;
  if (item.kind === "list") {
    const items = item.items
      .map((t) => `<text:list-item><text:p>${escapeXml(t)}</text:p></text:list-item>`)
      .join("");
    return `<text:list>${items}</text:list>`;
  }
  const name = item.name ? ` table:name="${escapeXml(item.name)}"` : "";
  const rows = item.rows
    .map(
      (r) =>
        `<table:table-row>${r
          .map((c) => cellXml(typeof c === "string" ? { text: c } : c))
          .join("")}</table:table-row>`,
    )
    .join("");
  return `<table:table${name}>${rows}</table:table>`;
};

/** Собирает ODT: элементы внутри `office:text` (порядок — как в документе). */
export function buildOdt(items: OdtItem[], opts: OdfBuildOptions = {}): Uint8Array {
  return buildOdfPackage(
    "application/vnd.oasis.opendocument.text",
    `<office:text>${items.map(odtItemXml).join("")}</office:text>`,
    opts,
  );
}
