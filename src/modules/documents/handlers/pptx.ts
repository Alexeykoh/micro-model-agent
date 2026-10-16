/**
 * PPTX → `DocumentIR` (группа office, INV-D2/D5).
 *
 * Части `ppt/slides/slide{N}.xml` в числовом порядке имён архива. На слайд: узел
 * outline (`kind:"slide"`, заголовок — первый непустой текст либо `Slide N`) и
 * блок-`paragraph` с текстом слайда (раны `a:t` склеиваются по фигуре/абзацу).
 * `meta.pages` — число слайдов, `meta.title` — display. Нет частей слайдов →
 * `meta.degraded` (INV-D5). Политику не реализует (INV-D6).
 */
import { boundLine, boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR, type DocumentIR } from "../ir";
import { child, findAll, readOoxml, textOf } from "./ooxml";

/** Имя части слайда → его номер, либо `null` (не слайд). */
function slideNumber(name: string): number | null {
  const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Текст одной фигуры `p:sp`: абзацы `a:p` (раны `a:t` склеены) через перевод строки. */
function shapeText(sp: unknown): string {
  const paragraphs = findAll(child(sp, "p:txBody"), "a:p").map((p) =>
    findAll(p, "a:r")
      .map((r) => textOf(child(r, "a:t")))
      .join(""),
  );
  return paragraphs
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join("\n");
}

/** Текст слайда: тексты фигур `p:sp` дерева `p:cSld/p:spTree`, склеенные переводом строки. */
function slideText(slide: unknown): string {
  const tree = child(child(child(slide, "p:sld"), "p:cSld"), "p:spTree");
  return findAll(tree, "p:sp")
    .map(shapeText)
    .filter((s) => s !== "")
    .join("\n");
}

/** Обработчик PPTX (группа office). */
export const pptxHandler: DocumentHandler = {
  id: "pptx",
  group: "office",
  extensions: [".pptx"],
  mediaTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  detect: (h) => detectHead(h) === "zip",
  async parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR> {
    const bytes = await source.bytes();
    const ir = emptyIR("pptx", bytes.length);
    ir.meta.title = source.display;
    const ooxml = readOoxml(bytes);

    const slides: Array<{ name: string; num: number }> = [];
    for (const name of ooxml.zip.keys()) {
      const num = slideNumber(name);
      if (num !== null) slides.push({ name, num });
    }
    slides.sort((a, b) => a.num - b.num);
    ir.meta.pages = slides.length;

    let emitted = 0;
    for (const { name, num } of slides) {
      const text = slideText(ooxml.xml(name));
      const title = text.split("\n").find((line) => line !== "") ?? `Slide ${num}`;
      ir.outline.push({ id: `slide:${num}`, level: 1, title: boundLine(title, ctx.limits), kind: "slide" });
      if (text) {
        ir.blocks.push({ kind: "paragraph", text: boundText(text, ctx.limits) });
        emitted++;
      }
    }
    if (slides.length === 0) ir.meta.degraded = { reason: "в пакете нет частей слайдов" };
    else if (emitted === 0) ir.meta.degraded = { reason: "слайды без текста" };
    return ir;
  },
};
