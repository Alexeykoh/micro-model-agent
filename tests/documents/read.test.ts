import { describe, expect, it } from "vitest";
import { parseSelector, renderDocumentRead } from "../../src/modules/documents/read";
import type { DocumentIR } from "../../src/modules/documents/ir";

const ir: DocumentIR = {
  meta: { format: "md", bytes: 10 },
  outline: [],
  blocks: [
    { kind: "heading", level: 1, text: "A" },
    { kind: "paragraph", text: "hello" },
    { kind: "heading", level: 1, text: "B" },
    { kind: "paragraph", text: "world" },
  ],
};

describe("read", () => {
  it("parseSelector разбирает section и lines", () => {
    expect(parseSelector("section:B")).toEqual({ kind: "section", arg: "B" });
    expect(parseSelector("lines:2-3")).toEqual({ kind: "lines", arg: [2, 3] });
    expect(parseSelector("all")).toEqual({ kind: "all" });
  });
  it("section вырезает блоки до следующего заголовка того же уровня", () => {
    const out = renderDocumentRead(ir, { kind: "section", arg: "A" });
    expect(out).toContain("hello");
    expect(out).not.toContain("world");
  });
  it("lines нумерует блоки", () => {
    const out = renderDocumentRead(ir, { kind: "lines", arg: [3, 4] });
    expect(out).toContain("world");
    expect(out).not.toContain("hello");
  });
});
