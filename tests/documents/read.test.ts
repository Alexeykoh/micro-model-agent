import { describe, expect, it } from "vitest";
import { parseSelector, renderDocumentRead } from "../../src/modules/documents/read";
import type { DocumentIR } from "../../src/modules/documents/ir";

const ir: DocumentIR = {
  meta: { format: "md", bytes: 10 },
  outline: [
    { id: "h0", level: 1, title: "A", kind: "section" },
    { id: "h1", level: 1, title: "B", kind: "section" },
  ],
  blocks: [
    { kind: "heading", level: 1, text: "A" },
    { kind: "paragraph", text: "hello" },
    { kind: "heading", level: 1, text: "B" },
    { kind: "paragraph", text: "world" },
  ],
};

describe("read", () => {
  it("parseSelector разбирает section и blocks", () => {
    expect(parseSelector("section:B")).toEqual({ kind: "section", arg: "B" });
    expect(parseSelector("blocks:2-3")).toEqual({ kind: "blocks", arg: [2, 3] });
    expect(parseSelector("all")).toEqual({ kind: "all" });
    expect(parseSelector("")).toEqual({ kind: "all" });
  });
  it("неизвестный селектор не притворяется all", () => {
    expect(parseSelector("page:3")).toEqual({ kind: "unknown", arg: "page:3" });
  });
  it("section вырезает блоки до следующего заголовка того же уровня", () => {
    const out = renderDocumentRead(ir, { kind: "section", arg: "A" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toContain("hello");
      expect(out.text).not.toContain("world");
    }
  });
  it("section совпадает без учёта регистра", () => {
    const out = renderDocumentRead(ir, { kind: "section", arg: "b" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toContain("world");
  });
  it("отсутствующий раздел — явный отказ со списком доступных", () => {
    expect(renderDocumentRead(ir, { kind: "section", arg: "nope" })).toEqual({
      ok: false,
      kind: "section-not-found",
      arg: "nope",
      available: ["A", "B"],
    });
  });
  it("blocks нумерует блоки", () => {
    const out = renderDocumentRead(ir, { kind: "blocks", arg: [3, 4] });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toContain("world");
      expect(out.text).not.toContain("hello");
    }
  });
  it("селектор по блокам не подменяется строками (blocks, не lines)", () => {
    expect(parseSelector("lines:2-3")).toEqual({ kind: "unknown", arg: "lines:2-3" });
  });
  it("списки рендерятся по list.ordered", () => {
    const doc: DocumentIR = {
      meta: { format: "md", bytes: 1 },
      outline: [],
      blocks: [
        { kind: "list", ordered: false, items: ["a", "b"] },
        { kind: "list", ordered: true, items: ["c", "d"] },
      ],
    };
    const out = renderDocumentRead(doc, { kind: "all" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toContain("- a");
      expect(out.text).toContain("1. c");
      expect(out.text).toContain("2. d");
    }
  });
  it("формат без заголовков (json) на section даёт явный отказ, не весь документ", () => {
    const flat: DocumentIR = {
      meta: { format: "json", bytes: 4 },
      outline: [{ id: "k:a", level: 1, title: "a", kind: "section" }],
      blocks: [{ kind: "code", lang: "json", text: "{}" }],
    };
    const out = renderDocumentRead(flat, { kind: "section", arg: "a" });
    expect(out).toEqual({ ok: false, kind: "section-not-found", arg: "a", available: ["a"] });
  });
  it("неизвестный селектор — явный отказ", () => {
    expect(renderDocumentRead(ir, { kind: "unknown", arg: "page:3" })).toEqual({
      ok: false,
      kind: "unknown-selector",
      arg: "page:3",
    });
  });
});
