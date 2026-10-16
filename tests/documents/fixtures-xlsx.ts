/**
 * Минимальная валидная книга XLSX для тестов (не под `src/`).
 *
 * Собирает детерминированный OOXML-пакет: `[Content_Types].xml`, `_rels/.rels`,
 * `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`,
 * `xl/worksheets/sheet{N}.xml`. Строковые значения — через sharedStrings либо
 * inlineStr (по `inline`), числа — литералом в `<v>`.
 */
import { buildZip } from "./fixtures-zip";

export interface XlsxSheetSpec {
  name: string;
  /** `null` в строке — пропуск ячейки (сдвиг колонки): проверяет выравнивание пропусков. */
  rows: Array<Array<string | number | null>>;
  /** true → строки как inlineStr (отдельная ветка парсера). */
  inline?: boolean;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** A=0 → "A", 25 → "Z", 26 → "AA". */
export function colName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Собирает XLSX-пакет из набора листов. */
export function buildXlsx(sheets: XlsxSheetSpec[]): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const intern = (s: string): number => {
    const hit = sharedIndex.get(s);
    if (hit !== undefined) return hit;
    const idx = shared.length;
    shared.push(s);
    sharedIndex.set(s, idx);
    return idx;
  };

  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((cells, r) => {
        const cellsXml = cells
          .map((value, c) => {
            if (value === null) return ""; // пропуск ячейки — колонка не заполняется
            const ref = `${colName(c)}${r + 1}`;
            if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
            const text = escapeXml(String(value));
            if (sheet.inline) return `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
            return `<c r="${ref}" t="s"><v>${intern(String(value))}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cellsXml}</row>`;
      })
      .join("");
    return `${XML_HEAD}<worksheet xmlns="${NS_MAIN}"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const workbook =
    `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
    sheets
      .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    "</sheets></workbook>";

  const workbookRels =
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
    sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    "</Relationships>";

  const sharedStrings =
    `${XML_HEAD}<sst xmlns="${NS_MAIN}" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join("") +
    "</sst>";

  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_s, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    "</Types>";

  const rootRels =
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    "</Relationships>";

  const entries = [
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/sharedStrings.xml", data: sharedStrings },
    ...sheetXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
  ];
  return buildZip(entries);
}
