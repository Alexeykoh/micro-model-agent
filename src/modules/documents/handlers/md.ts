/**
 * Markdown → `DocumentIR` (текстовая группа).
 */
import { boundLine } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** Markdown → IR: заголовки → outline+heading, остальное — абзацы/код. */
export const mdHandler: DocumentHandler = {
  id: "md",
  group: "text",
  extensions: [".md", ".markdown", ".mdown"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const bytes = await source.bytes();
    const text = new TextDecoder().decode(bytes);
    const ir = emptyIR("md", bytes.length);
    const lines = text.split(/\r?\n/);
    let para: string[] = [];
    let code: string[] | null = null;
    let n = 0;
    const flushPara = () => {
      if (para.length) { ir.blocks.push({ kind: "paragraph", text: para.join(" ").trim() }); para = []; }
    };
    for (const line of lines) {
      if (line.startsWith("```")) {
        if (code) { ir.blocks.push({ kind: "code", text: code.join("\n") }); code = null; }
        else { flushPara(); code = []; }
        continue;
      }
      if (code) { code.push(line); continue; }
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (m) {
        flushPara();
        const level = m[1].length;
        const title = m[2].trim();
        const bounded = boundLine(title, ctx.limits);
        ir.blocks.push({ kind: "heading", level, text: bounded });
        ir.outline.push({ id: `h${n++}`, level, title: bounded, kind: "section" });
        if (level === 1 && !ir.meta.title) ir.meta.title = title;
        continue;
      }
      if (line.trim() === "") flushPara();
      else para.push(line.trim());
    }
    flushPara();
    return ir;
  },
};
