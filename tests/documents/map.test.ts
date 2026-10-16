import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import { renderDocumentMap } from "../../src/modules/documents/map";
import type { DocumentIR } from "../../src/modules/documents/ir";

const ir: DocumentIR = {
  meta: { format: "md", title: "Doc", bytes: 10 },
  outline: [
    { id: "h0", level: 1, title: "A", kind: "section" },
    { id: "h1", level: 2, title: "B", kind: "section" },
  ],
  blocks: [
    { kind: "heading", level: 1, text: "A" },
    { kind: "table", table: { header: ["x"], rows: [["1"]] } },
  ],
};

describe("renderDocumentMap", () => {
  it("перечисляет структуру и счётчики", () => {
    const out = renderDocumentMap(ir);
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(out).toContain("format: md");
  });
  it("пустой sheets не даёт строку sheets:", () => {
    const out = renderDocumentMap({ ...ir, meta: { ...ir.meta, sheets: [] } });
    expect(out).not.toContain("sheets:");
  });
  it("непустой sheets перечисляет листы", () => {
    const out = renderDocumentMap({ ...ir, meta: { ...ir.meta, sheets: ["S1", "S2"] } });
    expect(out).toContain("sheets: S1, S2");
  });
  it("огромный outline усекается по DEFAULT_DOC_LIMITS (INV-D4)", () => {
    const outline = Array.from({ length: 1000 }, (_, i) => ({
      id: `n${i}`,
      level: 1,
      title: `node ${i}`,
      kind: "section" as const,
    }));
    const out = renderDocumentMap({ ...ir, outline });
    expect(out).toContain("truncated");
    expect(out.split("\n").length).toBeLessThanOrEqual(DEFAULT_DOC_LIMITS.maxLines + 2);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_DOC_LIMITS.maxChars + 64);
  });
});
