/**
 * XML/SVG → `DocumentIR` (текстовая группа).
 */
import { boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** XML/SVG-схема → IR: теги верхнего уровня — в outline, разметка — code-блок. */
export const xmlHandler: DocumentHandler = {
  id: "xml",
  group: "text",
  extensions: [".xml", ".xsd", ".svg", ".plist", ".drawio"],
  detect: (h) => detectHead(h) === "unknown" || detectHead(h) === "svg",
  async parse(ctx: ParseContext, source: DocSource) {
    const bytes = await source.bytes();
    const text = new TextDecoder().decode(bytes);
    const ir = emptyIR(source.ext.replace(".", "") || "xml", bytes.length);
    // Теги внутри комментариев не размечаем; имена атрибутов/их значений не начинаются
    // с `<`, поэтому как теги не ловятся (известное ограничение: `<` внутри значения
    // атрибута всё же будет принят за тег).
    const scan = text.replace(/<!--[\s\S]*?-->/g, "");
    const seen = new Set<string>();
    for (const m of scan.matchAll(/<([A-Za-z_][\w.-]*)\b/g)) {
      const tag = m[1];
      if (seen.has(tag)) continue;
      seen.add(tag);
      ir.outline.push({ id: `t:${tag}`, level: 1, title: tag, kind: "section" });
      if (ir.outline.length >= 60) break;
    }
    ir.blocks.push({ kind: "code", lang: "xml", text: boundText(text, ctx.limits) });
    ir.meta.title = source.display;
    return ir;
  },
};
