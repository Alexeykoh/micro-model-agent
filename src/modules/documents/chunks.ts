/**
 * Чанкинг `DocumentIR` (INV-D2/D4): потребитель видит только нормализованное
 * представление, форматы не знает. Один блок → один чанк (или несколько, если
 * текст блока длиннее `maxChunkChars`); текущая секция ведётся по последнему
 * `heading`. Число чанков жёстко ограничено — лишнее отбрасывается с заметкой.
 */
import type { DocBlock, DocumentIR } from "./ir";

/** Чанк — минимальная единица поиска: текст и (опционально) заголовок секции. */
export interface DocChunk {
  id: string;
  text: string;
  section?: string;
}

/** Опции чанкинга: границы размера чанка и числа чанков на документ. */
export interface ChunkOptions {
  maxChunkChars?: number;
  maxChunksPerDoc?: number;
}

/** Потолок символов в одном чанке (INV-D4). */
export const DEFAULT_MAX_CHUNK_CHARS = 1200;

/** Потолок числа чанков на документ (INV-D4). */
export const DEFAULT_MAX_CHUNKS_PER_DOC = 200;

/** Маркер безопасного усечения чанка, если нарезка почему-то не сработала. */
const CLIP_MARKER = "[…truncated…]";

/** Текстовое представление блока для поиска (фигура → короткий маркер). */
function blockText(b: DocBlock): string {
  switch (b.kind) {
    case "heading":
      return b.text;
    case "paragraph":
      return b.text;
    case "code":
      return b.text;
    case "list":
      return b.items.map((item, n) => `${b.ordered ? `${n + 1}.` : "-"} ${item}`).join("\n");
    case "table":
      return [b.table.header.join(" | "), ...b.table.rows.map((r) => r.join(" | "))].join("\n");
    case "figure":
      return `[figure: ${b.ref.kind} ${b.ref.mime}${b.caption ? ` — ${b.caption}` : ""}]`;
  }
}

/** Режет текст на куски ≤ maxChars, предпочитая границы строк/пробелов. */
function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = maxChars;
    const brk = Math.max(rest.lastIndexOf("\n", maxChars), rest.lastIndexOf(" ", maxChars));
    if (brk > maxChars * 0.5) cut = brk;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) out.push(rest);
  return out;
}

/** Финальная страховка: чанк не длиннее maxChars даже с маркером (INV-D4). */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const out = `${text.slice(0, Math.max(0, maxChars - CLIP_MARKER.length))}${CLIP_MARKER}`;
  // При крошечном maxChunkChars маркер сам по себе длиннее — режем и его.
  return out.length <= maxChars ? out : CLIP_MARKER.slice(0, maxChars);
}

/**
 * Сводит `DocumentIR` к списку чанков (INV-D2/D4). Секция чанка — заголовок
 * последнего `heading` (или `meta.title` до первого). При переполнении
 * `maxChunksPerDoc` последний слот занимает чанк-заметка, поэтому длина
 * результата никогда не превышает кап.
 */
export function chunkIR(ir: DocumentIR, opts: ChunkOptions = {}): DocChunk[] {
  const maxChars = Math.max(1, opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS);
  const cap = Math.max(1, opts.maxChunksPerDoc ?? DEFAULT_MAX_CHUNKS_PER_DOC);
  const chunks: DocChunk[] = [];
  let section = ir.meta.title;
  let dropped = 0;

  for (const block of ir.blocks) {
    if (block.kind === "heading") section = block.text;
    const sec = section ? { section } : {};
    for (const part of splitText(blockText(block), maxChars)) {
      const text = clip(part, maxChars);
      if (!text) continue; // пустой текст не эмитим — он не несёт поисковой ценности (INV-D4)
      if (chunks.length < cap) {
        chunks.push({ id: `c${chunks.length}`, text, ...sec });
      } else {
        dropped += 1;
      }
    }
  }

  if (dropped > 0) {
    // Последний слот заменяется заметкой — длина остаётся ≤ cap (INV-D4).
    // Заметка проходит через `clip`, чтобы уважать и кастомный `maxChunkChars`.
    dropped += 1;
    chunks[cap - 1] = {
      id: `c${cap - 1}`,
      text: clip(`[... truncated: ${dropped} more chunks ...]`, maxChars),
      ...(section ? { section } : {}),
    };
  }
  return chunks;
}
