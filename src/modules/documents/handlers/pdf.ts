/**
 * PDF → `DocumentIR` (группа pdf, INV-D2/D5).
 *
 * Текстовый слой через `pdfjs-dist` (legacy build, без canvas). Оглавление берётся
 * из закладок документа (`getOutline()`, узлы `kind:"section"`, уровень из
 * вложенности); если закладок нет — эвристика: первая непустая строка страницы →
 * блок-`heading` + узел outline, остальные строки → `paragraph`. `meta.pages` —
 * число страниц, `meta.title` — display. Нет текста ни на одной странице (скан) →
 * `meta.degraded` с причиной, без исключения (INV-D5); малоформированный PDF
 * бросает исключение наружу — это fail-open тула, а не деградация (INV-D5).
 * Политику не реализует (INV-D6). Единственный импортёр `pdfjs-dist` (INV-D8).
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
// @ts-expect-error — у `pdf.worker.mjs` нет .d.mts: модуль воркера поставляется только в рантайме.
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR, type DocumentIR } from "../ir";

// Fake-worker: иначе pdfjs динамически импортирует `pdf.worker.mjs` рядом с
// бандлом и падает без него. Хук берёт WorkerMessageHandler из уже вшитого
// модуля (W0-спайк); `Object.assign` — без кастов к `any`.
Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler } });

/** Тип документа pdfjs (выводим из `getDocument`, не импортируя тип напрямую). */
type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;
/** Элемент дерева закладок pdfjs. */
type OutlineItem = Awaited<ReturnType<PdfDocument["getOutline"]>>[number];

/**
 * Текст страницы из `getTextContent().items`: склейка `str`-ранов, `hasEOL`
 * добавляет перевод строки. Чужие элементы (marked content) пропускаются —
 * доступ к полям через `in`-сужение, без кастов.
 */
function pageText(items: readonly unknown[]): string {
  let out = "";
  for (const it of items) {
    if (typeof it !== "object" || it === null) continue;
    if ("str" in it && typeof it.str === "string") out += it.str;
    if ("hasEOL" in it && it.hasEOL === true) out += "\n";
  }
  return out;
}

/** Непустые (после trim) строки текста страницы. */
function pageLines(items: readonly unknown[]): string[] {
  return pageText(items)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Дерево закладок → outline (`kind:"section"`, уровень из вложенности). */
function pushOutline(nodes: OutlineItem[], level: number, ir: DocumentIR, counter: { n: number }): void {
  for (const node of nodes) {
    const raw = typeof node.title === "string" ? node.title : "";
    const title = raw.trim() || `Section ${counter.n + 1}`;
    ir.outline.push({ id: `outline:${counter.n++}`, level, title, kind: "section" });
    if (Array.isArray(node.items) && node.items.length > 0) {
      pushOutline(node.items, level + 1, ir, counter);
    }
  }
}

/** Обработчик PDF (группа pdf). */
export const pdfHandler: DocumentHandler = {
  id: "pdf",
  group: "pdf",
  extensions: [".pdf"],
  mediaTypes: ["application/pdf"],
  detect: (h) => detectHead(h) === "pdf",
  async parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR> {
    const bytes = await source.bytes();
    const ir = emptyIR("pdf", bytes.length);
    ir.meta.title = source.display;
    // Копия: pdfjs забирает (detach) переданный буфер — исходный `bytes` и его
    // length должны остаться валидными для вызывающей стороны.
    const task = getDocument({ data: bytes.slice() });
    try {
      const doc = await task.promise;
      ir.meta.pages = doc.numPages;

      const bookmark = await doc.getOutline();
      const hasOutline = Array.isArray(bookmark) && bookmark.length > 0;
      if (hasOutline) pushOutline(bookmark, 1, ir, { n: 0 });

      let total = "";
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const lines = pageLines(content.items);
        total += `${lines.join("\n")}\n`;
        if (lines.length === 0) continue; // пустая страница не даёт пустых блоков (INV-D5)
        if (hasOutline) {
          ir.blocks.push({ kind: "paragraph", text: boundText(lines.join("\n"), ctx.limits) });
        } else {
          ir.outline.push({ id: `page:${n}`, level: 1, title: lines[0], kind: "section" });
          ir.blocks.push({ kind: "heading", level: 1, text: lines[0] });
          const rest = lines.slice(1).join("\n");
          if (rest) ir.blocks.push({ kind: "paragraph", text: boundText(rest, ctx.limits) });
        }
      }
      if (total.trim() === "") ir.meta.degraded = { reason: "нет текстового слоя (скан?)" };
      return ir;
    } finally {
      await task.destroy();
    }
  },
};
