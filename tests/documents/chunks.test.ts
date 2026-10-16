import { describe, expect, it } from "vitest";
import {
  chunkIR,
  DEFAULT_MAX_CHUNK_CHARS,
  DEFAULT_MAX_CHUNKS_PER_DOC,
} from "../../src/modules/documents/chunks";
import type { DocumentIR } from "../../src/modules/documents/ir";

/** IR из блоков с метаданными по умолчанию. */
function ir(blocks: DocumentIR["blocks"], meta: Partial<DocumentIR["meta"]> = {}): DocumentIR {
  return { meta: { format: "md", bytes: 1, ...meta }, outline: [], blocks };
}

describe("chunkIR: секции и тексты блоков", () => {
  it("ведёт текущую секцию по заголовкам", () => {
    const chunks = chunkIR(
      ir([
        { kind: "heading", level: 1, text: "A" },
        { kind: "paragraph", text: "hello" },
        { kind: "heading", level: 2, text: "B" },
        { kind: "paragraph", text: "world" },
      ]),
    );
    expect(chunks.map((c) => c.section)).toEqual(["A", "A", "B", "B"]);
    expect(chunks.map((c) => c.text)).toEqual(["A", "hello", "B", "world"]);
  });

  it("до первого заголовка секция берётся из meta.title", () => {
    const chunks = chunkIR(ir([{ kind: "paragraph", text: "intro" }], { title: "Intro" }));
    expect(chunks[0].section).toBe("Intro");
  });

  it("список и таблица сводятся к тексту, фигура — к маркеру", () => {
    const chunks = chunkIR(
      ir([
        { kind: "list", ordered: true, items: ["one", "two"] },
        { kind: "table", table: { header: ["h1", "h2"], rows: [["a", "b"]] } },
        { kind: "figure", caption: "cap", ref: { kind: "raster", mime: "image/png", bytes: 3 } },
      ]),
    );
    expect(chunks[0].text).toContain("1. one");
    expect(chunks[0].text).toContain("2. two");
    expect(chunks[1].text).toContain("h1 | h2");
    expect(chunks[1].text).toContain("a | b");
    expect(chunks[2].text).toContain("figure");
    expect(chunks[2].text).toContain("image/png");
  });

  it("пустой документ даёт пустой список чанков", () => {
    expect(chunkIR(ir([]))).toEqual([]);
  });
});

describe("chunkIR: нарезка и капы", () => {
  it("длинный блок режется на куски ≤ maxChunkChars", () => {
    const long = "word ".repeat(500).trim();
    const chunks = chunkIR(ir([{ kind: "paragraph", text: long }]), { maxChunkChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(100);
  });

  it("кап числа чанков: при переполнении последний — заметка, длина ≤ капа", () => {
    const blocks = Array.from({ length: 20 }, (_, i) => ({ kind: "paragraph" as const, text: `p${i}` }));
    const chunks = chunkIR(ir(blocks), { maxChunksPerDoc: 5 });
    expect(chunks.length).toBe(5);
    expect(chunks[4].text).toContain("truncated");
    expect(chunks[4].text).toContain("16"); // 20 блоков − 4 сохранённых = 16 отброшено
  });

  it("ровно по капу без заметки, если нечего терять", () => {
    const blocks = Array.from({ length: 5 }, (_, i) => ({ kind: "paragraph" as const, text: `p${i}` }));
    const chunks = chunkIR(ir(blocks), { maxChunksPerDoc: 5 });
    expect(chunks).toHaveLength(5);
    expect(chunks[4].text).toBe("p4");
  });

  it("дефолтные константы заданы", () => {
    expect(DEFAULT_MAX_CHUNK_CHARS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_CHUNKS_PER_DOC).toBeGreaterThan(0);
  });
});
