/**
 * Чтение среза документа по селектору (INV-D4): `all` | `section:<title>` |
 * `lines:<a>-<b>`. Рендер блока в текст — формат-агностичный.
 */
import { boundText } from "./bound";
import type { DocBlock, DocumentIR } from "./ir";

export type Selector =
  | { kind: "all" }
  | { kind: "section"; arg: string }
  | { kind: "lines"; arg: [number, number] };

/** Разбор строки-селектора: all | section:<title> | lines:<a>-<b>. */
export function parseSelector(sel: string): Selector {
  const s = (sel || "all").trim();
  const sec = /^section:(.+)$/i.exec(s);
  if (sec) return { kind: "section", arg: sec[1].trim() };
  const ln = /^lines:(\d+)-(\d+)$/i.exec(s);
  if (ln) return { kind: "lines", arg: [Number(ln[1]), Number(ln[2])] };
  return { kind: "all" };
}

/** Текстовое представление одного блока. */
function blockText(b: DocBlock): string {
  switch (b.kind) {
    case "heading":
      return `${"#".repeat(b.level)} ${b.text}`;
    case "paragraph":
      return b.text;
    case "code":
      return `\`\`\`${b.lang ?? ""}\n${b.text}\n\`\`\``;
    case "list":
      return b.items.map((i) => `- ${i}`).join("\n");
    case "table":
      return [b.table.header.join(" | "), ...b.table.rows.map((r) => r.join(" | "))].join("\n");
    case "figure":
      return `[figure: ${b.ref.kind} ${b.ref.mime}${b.caption ? ` — ${b.caption}` : ""}]`;
  }
}

/** Текстовый рендер выбранного среза IR (INV-D4). */
export function renderDocumentRead(ir: DocumentIR, sel: Selector, maxChars = 24_000): string {
  let blocks: DocBlock[];
  if (sel.kind === "section") {
    const start = ir.blocks.findIndex((b) => b.kind === "heading" && b.text === sel.arg);
    if (start < 0) blocks = ir.blocks;
    else {
      const level = (ir.blocks[start] as { level: number }).level;
      let end = ir.blocks.length;
      for (let i = start + 1; i < ir.blocks.length; i++) {
        const b = ir.blocks[i];
        if (b.kind === "heading" && b.level <= level) {
          end = i;
          break;
        }
      }
      blocks = ir.blocks.slice(start, end);
    }
  } else if (sel.kind === "lines") {
    blocks = ir.blocks.slice(Math.max(0, sel.arg[0] - 1), sel.arg[1]);
  } else {
    blocks = ir.blocks;
  }
  return boundText(blocks.map(blockText).join("\n\n"), {
    maxLines: 400,
    maxChars,
    maxTableRows: 50,
  });
}
