/**
 * HTML → `DocumentIR` (текстовая группа).
 */
import { boundLine, boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** HTML → IR: <title> и <h1..h6> в outline, текст без тегов — абзацы. */
export const htmlHandler: DocumentHandler = {
  id: "html",
  group: "text",
  extensions: [".html", ".htm"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const bytes = await source.bytes();
    const text = new TextDecoder().decode(bytes);
    const ir = emptyIR("html", bytes.length);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim();
    if (title) ir.meta.title = title;
    let n = 0;
    for (const m of text.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
      const level = Number(m[1]);
      const t = strip(m[2]).trim();
      if (!t) continue;
      const title = boundLine(t, ctx.limits);
      ir.blocks.push({ kind: "heading", level, text: title });
      ir.outline.push({ id: `h${n++}`, level, title, kind: "section" });
    }
    const body = strip(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ""));
    ir.blocks.push({ kind: "paragraph", text: boundText(body.replace(/\s+/g, " ").trim(), ctx.limits) });
    return ir;
  },
};

function strip(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
