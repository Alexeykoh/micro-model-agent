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
 * Обход страниц ограничен `MAX_PAGES`: если страниц больше, разбираются первые
 * `MAX_PAGES`, `meta.pages` остаётся истинным, а `meta.degraded` честно сообщает
 * «показаны первые N страниц» (INV-D5). Заголовки/закладки проходят `boundLine`
 * (INV-D4). Политику не реализует (INV-D6). Единственный импортёр `pdfjs-dist`
 * (INV-D8).
 *
 * `standardFontDataUrl` не задаётся осознанно: pdfjs логирует нефатальный warning
 * (стандартные шрифты не подгружаются), это влияет лишь на отрисовку глифов, не
 * на извлечение текста, поэтому предупреждение принято как безвредное.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
// @ts-expect-error — у `pdf.worker.mjs` нет .d.mts: модуль воркера поставляется только в рантайме.
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { boundLine, boundText } from "../bound";
import { detectHead, type DocLimits, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR, type DocumentIR } from "../ir";

/** Верхняя граница числа обходимых страниц (INV-D5): дальше — честная деградация. */
export const MAX_PAGES = 200;

// Fake-worker: иначе pdfjs динамически импортирует `pdf.worker.mjs` рядом с
// бандлом и падает без него. Хук берёт WorkerMessageHandler из уже вшитого
// модуля (W0-спайк); `Object.assign` — без кастов к `any`. Хук опирается на то,
// что pdfjs читает `globalThis.pdfjsWorker` лениво — внутри `getDocument`, уже
// после этого присваивания.
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

/** Дерево закладок → outline (`kind:"section"`, уровень из вложенности, INV-D4). */
function pushOutline(
  nodes: OutlineItem[],
  level: number,
  ir: DocumentIR,
  counter: { n: number },
  limits: DocLimits,
): void {
  for (const node of nodes) {
    const raw = typeof node.title === "string" ? node.title : "";
    const title = boundLine(raw.trim() || `Section ${counter.n + 1}`, limits);
    ir.outline.push({ id: `outline:${counter.n++}`, level, title, kind: "section" });
    if (Array.isArray(node.items) && node.items.length > 0) {
      pushOutline(node.items, level + 1, ir, counter, limits);
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
      if (hasOutline) pushOutline(bookmark, 1, ir, { n: 0 }, ctx.limits);

      let hasText = false;
      const walk = Math.min(doc.numPages, MAX_PAGES); // cap обхода (INV-D5)
      for (let n = 1; n <= walk; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const lines = pageLines(content.items);
        if (lines.length === 0) continue; // пустая страница не даёт пустых блоков (INV-D5)
        hasText = true;
        if (hasOutline) {
          ir.blocks.push({ kind: "paragraph", text: boundText(lines.join("\n"), ctx.limits) });
        } else {
          const title = boundLine(lines[0], ctx.limits);
          ir.outline.push({ id: `page:${n}`, level: 1, title, kind: "section" });
          ir.blocks.push({ kind: "heading", level: 1, text: title });
          const rest = lines.slice(1).join("\n");
          if (rest) ir.blocks.push({ kind: "paragraph", text: boundText(rest, ctx.limits) });
        }
      }
      if (!hasText) ir.meta.degraded = { reason: "нет текстового слоя (скан?)" };
      else if (doc.numPages > MAX_PAGES) ir.meta.degraded = { reason: `показаны первые ${MAX_PAGES} страниц` };
      return ir;
    } finally {
      await task.destroy();
    }
  },
};
