/**
 * CSV/TSV → `DocumentIR` (текстовая группа).
 */
import { boundTable } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** Простой CSV/TSV-парсер: кавычки, разделители, CRLF. */
function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.length > 0));
}

function make(id: string, extensions: string[], sep: string): DocumentHandler {
  return {
    id,
    group: "text",
    extensions,
    detect: (h) => detectHead(h) === "unknown",
    async parse(ctx: ParseContext, source: DocSource) {
      const bytes = await source.bytes();
      const text = new TextDecoder().decode(bytes);
      const ir = emptyIR(id, bytes.length);
      const rows = parseDelimited(text, sep);
      const header = rows.shift() ?? [];
      ir.blocks.push({ kind: "table", table: boundTable({ header, rows }, ctx.limits) });
      ir.meta.title = source.display;
      ir.outline.push({ id: "t0", level: 1, title: source.display, kind: "section" });
      return ir;
    },
  };
}

export const csvHandler = make("csv", [".csv"], ",");
export const tsvHandler = make("tsv", [".tsv", ".tab"], "\t");
