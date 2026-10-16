import { describe, expect, it } from "vitest";
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
});
