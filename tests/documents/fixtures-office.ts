/**
 * Минимальные OOXML-пакеты Office (DOCX/PPTX) для тестов (не под `src/`).
 *
 * Собирает детерминированный ZIP: `[Content_Types].xml`, `_rels/.rels` и
 * ключевую часть (`word/document.xml` либо `ppt/slides/slide{N}.xml`).
 * Обработчики читают только ключевую часть, поэтому styles/numbering/theme не нужны.
 */
import { buildZip } from "./fixtures-zip";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const contentTypes = (override: string): string =>
  `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  `<Override PartName="${override}" ContentType="application/vnd.openxmlformats-officedocument.${override.split("/")[1]}.main+xml"/>` +
  "</Types>";

const rootRels = (target: string): string =>
  `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>` +
  "</Relationships>";

export interface DocxBuildOptions {
  /** true → все записи архива методом 8 (deflate). */
  deflate?: boolean;
  /** true → не создавать `word/document.xml` (проверка отсутствующей части). */
  skipDocument?: boolean;
}

export type DocxBlock =
  | { kind: "p"; text?: string; style?: string; list?: boolean }
  | { kind: "tbl"; rows: string[][] };

const pXml = (p: Extract<DocxBlock, { kind: "p" }>): string => {
  const style = p.style ? `<w:pStyle w:val="${escapeXml(p.style)}"/>` : "";
  const num = p.list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "";
  const pPr = style || num ? `<w:pPr>${style}${num}</w:pPr>` : "";
  const run = p.text === undefined ? "" : `<w:r><w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r>`;
  return `<w:p>${pPr}${run}</w:p>`;
};

const tblXml = (tbl: Extract<DocxBlock, { kind: "tbl" }>): string =>
  `<w:tbl>${tbl.rows
    .map(
      (r) =>
        `<w:tr>${r
          .map((c) => `<w:tc><w:p><w:r><w:t>${escapeXml(c)}</w:t></w:r></w:p></w:tc>`)
          .join("")}</w:tr>`,
    )
    .join("")}</w:tbl>`;

/** Собирает DOCX: тело `w:body` из абзацев/таблиц, порядок сохраняется. */
export function buildDocx(blocks: DocxBlock[], opts: DocxBuildOptions = {}): Uint8Array {
  const body = blocks.map((b) => (b.kind === "p" ? pXml(b) : tblXml(b))).join("");
  const document = `${XML_HEAD}<w:document xmlns:w="${NS_W}"><w:body>${body}</w:body></w:document>`;
  const entries = [
    { name: "[Content_Types].xml", data: contentTypes("/word/document.xml") },
    { name: "_rels/.rels", data: rootRels("word/document.xml") },
    ...(opts.skipDocument
      ? []
      : [{ name: "word/document.xml", data: document, deflate: opts.deflate }]),
  ];
  return buildZip(entries);
}

export interface PptxBuildOptions {
  /** true → все записи архива методом 8 (deflate). */
  deflate?: boolean;
  /** true → не создавать ни одной части слайда (проверка отсутствующих слайдов). */
  skipSlides?: boolean;
}

/** Фигура слайда: раны одного абзаца (`a:r`/`a:t`), склеиваются в текст фигуры. */
export type PptxShape = string[];
/** Слайд: список фигур; каждый элемент — фигура из ран. */
export type PptxSlide = PptxShape[];

const shapeXml = (runs: PptxShape): string =>
  `<p:sp><p:txBody><a:bodyPr/><a:p>${runs
    .map((r) => `<a:r><a:t>${escapeXml(r)}</a:t></a:r>`)
    .join("")}</a:p></p:txBody></p:sp>`;

const slideXml = (slide: PptxSlide): string =>
  `${XML_HEAD}<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}">` +
  `<p:cSld><p:spTree>${slide.map(shapeXml).join("")}</p:spTree></p:cSld></p:sld>`;

/** Собирает PPTX: `ppt/slides/slide{N}.xml` (N с 1), порядок слайдов — как задан. */
export function buildPptx(slides: PptxSlide[], opts: PptxBuildOptions = {}): Uint8Array {
  const entries = [
    { name: "[Content_Types].xml", data: contentTypes("/ppt/presentation.xml") },
    { name: "_rels/.rels", data: rootRels("ppt/presentation.xml") },
    ...(opts.skipSlides
      ? []
      : slides.map((slide, i) => ({
          name: `ppt/slides/slide${i + 1}.xml`,
          data: slideXml(slide),
          deflate: opts.deflate,
        }))),
  ];
  return buildZip(entries);
}
