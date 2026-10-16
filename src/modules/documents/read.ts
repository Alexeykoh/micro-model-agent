/**
 * Чтение среза документа по селектору (INV-D4): `all` | `section:<title>` |
 * `blocks:<a>-<b>` (нумерация — по блокам IR, а не по строкам). Рендер блока
 * в текст — формат-агностичный.
 */
import { boundText, DEFAULT_DOC_LIMITS } from "./bound";
import type { DocBlock, DocumentIR } from "./ir";

export type Selector =
  | { kind: "all" }
  | { kind: "section"; arg: string }
  | { kind: "blocks"; arg: [number, number] }
  | { kind: "unknown"; arg: string };

/** Результат рендера среза: текст либо явная причина отказа (INV-D5). */
export type ReadOutcome =
  | { ok: true; text: string }
  | { ok: false; kind: "section-not-found"; arg: string; available: string[] }
  | { ok: false; kind: "unknown-selector"; arg: string };

/** Разбор строки-селектора: all | section:<title> | blocks:<a>-<b>. */
export function parseSelector(sel: string): Selector {
  const s = (sel || "all").trim();
  if (s === "" || /^all$/i.test(s)) return { kind: "all" };
  const sec = /^section:(.+)$/i.exec(s);
  if (sec) return { kind: "section", arg: sec[1].trim() };
  const bl = /^blocks:(\d+)-(\d+)$/i.exec(s);
  if (bl) return { kind: "blocks", arg: [Number(bl[1]), Number(bl[2])] };
  return { kind: "unknown", arg: s };
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
      return b.items.map((i, n) => `${b.ordered ? `${n + 1}.` : "-"} ${i}`).join("\n");
    case "table":
      return [b.table.header.join(" | "), ...b.table.rows.map((r) => r.join(" | "))].join("\n");
    case "figure":
      return `[figure: ${b.ref.kind} ${b.ref.mime}${b.caption ? ` — ${b.caption}` : ""}]`;
  }
}

/** Блок-заголовок раздела с совпадением без учёта регистра; иначе `null`. */
function findSection(ir: DocumentIR, title: string): { start: number; level: number } | null {
  const want = title.trim().toLowerCase();
  const start = ir.blocks.findIndex((b) => b.kind === "heading" && b.text.trim().toLowerCase() === want);
  const block = start >= 0 ? ir.blocks[start] : undefined;
  if (!block || block.kind !== "heading") return null;
  return { start, level: block.level };
}

/** Текстовый рендер выбранного среза IR (INV-D4). */
export function renderDocumentRead(
  ir: DocumentIR,
  sel: Selector,
  limits = DEFAULT_DOC_LIMITS,
): ReadOutcome {
  let blocks: DocBlock[];
  if (sel.kind === "section") {
    const found = findSection(ir, sel.arg);
    if (!found) {
      return {
        ok: false,
        kind: "section-not-found",
        arg: sel.arg,
        available: ir.outline.map((n) => n.title),
      };
    }
    let end = ir.blocks.length;
    for (let i = found.start + 1; i < ir.blocks.length; i++) {
      const b = ir.blocks[i];
      if (b.kind === "heading" && b.level <= found.level) {
        end = i;
        break;
      }
    }
    blocks = ir.blocks.slice(found.start, end);
  } else if (sel.kind === "blocks") {
    blocks = ir.blocks.slice(Math.max(0, sel.arg[0] - 1), sel.arg[1]);
  } else if (sel.kind === "unknown") {
    return { ok: false, kind: "unknown-selector", arg: sel.arg };
  } else {
    blocks = ir.blocks;
  }
  return { ok: true, text: boundText(blocks.map(blockText).join("\n\n"), limits) };
}
