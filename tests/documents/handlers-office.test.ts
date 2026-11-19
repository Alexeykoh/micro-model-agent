import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import { docxHandler } from "../../src/modules/documents/handlers/docx";
import { MAX_TABLE_COLS } from "../../src/modules/documents/handlers/ooxml";
import { odtHandler } from "../../src/modules/documents/handlers/odt";
import { pptxHandler } from "../../src/modules/documents/handlers/pptx";
import type { Logger } from "../../src/logger/app-logger";
import { buildDocx, buildPptx } from "./fixtures-office";
import { buildOdt } from "./fixtures-odf";
import { buildZip } from "./fixtures-zip";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = (limits = DEFAULT_DOC_LIMITS) => ({ logger, limits });
const src = (bytes: Uint8Array, display: string) => ({
  path: display,
  display,
  ext: display.slice(display.lastIndexOf(".")),
  bytes: async () => bytes,
});

describe("docxHandler", () => {
  const bytes = buildDocx([
    { kind: "p", text: "Title", style: "Heading1" },
    { kind: "p", text: "Intro paragraph" },
    { kind: "p", text: "Item one", list: true },
    { kind: "p", text: "Item two", list: true },
    { kind: "p", text: "Section", style: "heading 2" },
    { kind: "tbl", rows: [["A", "B"], ["1", "2"]] },
  ]);

  it("заголовки → heading + outline, первый Heading1 → meta.title", async () => {
    const ir = await docxHandler.parse(ctx(), src(bytes, "doc.docx"));
    expect(ir.meta.format).toBe("docx");
    expect(ir.meta.title).toBe("Title");
    expect(ir.outline).toEqual([
      { id: "h0", level: 1, title: "Title", kind: "section" },
      { id: "h1", level: 2, title: "Section", kind: "section" },
    ]);
    const headings = ir.blocks.filter((b) => b.kind === "heading");
    expect(headings).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "heading", level: 2, text: "Section" },
    ]);
  });

  it("абзац и список (ordered:false), таблица из w:tbl", async () => {
    const ir = await docxHandler.parse(ctx(), src(bytes, "doc.docx"));
    const para = ir.blocks.find((b) => b.kind === "paragraph");
    expect(para).toEqual({ kind: "paragraph", text: "Intro paragraph" });
    const list = ir.blocks.find((b) => b.kind === "list");
    expect(list).toEqual({ kind: "list", ordered: false, items: ["Item one", "Item two"] });
    const table = ir.blocks.find((b) => b.kind === "table");
    if (!table || table.kind !== "table") throw new Error("expect table");
    expect(table.table.header).toEqual(["A", "B"]);
    expect(table.table.rows).toEqual([["1", "2"]]);
  });

  it("отсутствие word/document.xml → degraded, без исключения (INV-D5)", async () => {
    const ir = await docxHandler.parse(ctx(), src(buildDocx([], { skipDocument: true }), "d.docx"));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("архив без документа → degraded", async () => {
    const ir = await docxHandler.parse(ctx(), src(buildZip([{ name: "x.txt", data: "no" }]), "d.docx"));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("пустое тело → degraded, не пустой успех (INV-D5)", async () => {
    const ir = await docxHandler.parse(ctx(), src(buildDocx([{ kind: "p" }]), "d.docx"));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("HeadingChar и подобные не считаются заголовком (regex заякорен)", async () => {
    const ir = await docxHandler.parse(ctx(), src(buildDocx([{ kind: "p", text: "X", style: "HeadingChar" }]), "d.docx"));
    expect(ir.blocks).toEqual([{ kind: "paragraph", text: "X" }]);
    expect(ir.meta.degraded).toBeUndefined();
  });

  it("ячейка из нескольких w:p склеивается через \\n", async () => {
    const b = buildDocx([{ kind: "tbl", rows: [["H1", "H2"], [["line1", "line2"], "b"]] }]);
    const ir = await docxHandler.parse(ctx(), src(b, "d.docx"));
    const table = ir.blocks.find((x) => x.kind === "table");
    if (!table || table.kind !== "table") throw new Error("expect table");
    expect(table.table.header).toEqual(["H1", "H2"]);
    expect(table.table.rows).toEqual([["line1\nline2", "b"]]);
  });

  it("превышение maxTableRows → truncated, cap при разборе (INV-D4)", async () => {
    const rows: string[][] = [["h"]];
    for (let i = 0; i < 5; i++) rows.push([String(i)]);
    const b = buildDocx([{ kind: "tbl", rows }]);
    const ir = await docxHandler.parse(ctx({ ...DEFAULT_DOC_LIMITS, maxTableRows: 2 }), src(b, "d.docx"));
    const table = ir.blocks[0];
    if (table.kind !== "table") throw new Error("expect table");
    expect(table.table.truncated).toBe(true);
    expect(table.table.rows).toHaveLength(2);
  });

  it("пустой w:tbl пропускается → degraded, не пустой успех", async () => {
    const ir = await docxHandler.parse(ctx(), src(buildDocx([{ kind: "tbl", rows: [] }]), "d.docx"));
    expect(ir.blocks).toEqual([]);
    expect(ir.meta.degraded?.reason).toBeTruthy();
  });

  it("w:tbl из одних пустых ячеек пропускается → degraded (единый tableHasContent)", async () => {
    const ir = await docxHandler.parse(ctx(), src(buildDocx([{ kind: "tbl", rows: [["", ""]] }]), "d.docx"));
    expect(ir.blocks).toEqual([]);
    expect(ir.meta.degraded?.reason).toBeTruthy();
  });

  it("w:tbl с пустой строкой и непустым абзацем: таблица пропущена, абзац остался", async () => {
    const b = buildDocx([{ kind: "tbl", rows: [["", ""]] }, { kind: "p", text: "text" }]);
    const ir = await docxHandler.parse(ctx(), src(b, "d.docx"));
    expect(ir.blocks).toEqual([{ kind: "paragraph", text: "text" }]);
    expect(ir.meta.degraded).toBeUndefined();
  });

  it("колонки w:tbl обрезаются до MAX_TABLE_COLS с truncated (INV-D4)", async () => {
    const wide = Array.from({ length: MAX_TABLE_COLS + 1 }, (_, i) => `c${i}`);
    const b = buildDocx([{ kind: "tbl", rows: [wide] }]);
    const ir = await docxHandler.parse(ctx(), src(b, "d.docx"));
    const table = ir.blocks.find((x) => x.kind === "table");
    if (!table || table.kind !== "table") throw new Error("expect table");
    expect(table.table.header).toHaveLength(MAX_TABLE_COLS);
    expect(table.table.truncated).toBe(true);
  });

  it("detect проходит только на ZIP-magic", () => {
    expect(docxHandler.detect?.(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(docxHandler.detect?.(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
  });
});

describe("odtHandler", () => {
  const bytes = buildOdt([
    { kind: "h", level: 1, text: "Title" },
    { kind: "h", level: 2, text: "Sub" },
    { kind: "p", text: "Hello world" },
    { kind: "list", items: ["one", "two"] },
    { kind: "table", name: "T1", rows: [["H1", "H2"], ["a", "b"]] },
  ]);

  it("заголовки → heading + outline уровня из outline-level", async () => {
    const ir = await odtHandler.parse(ctx(), src(bytes, "doc.odt"));
    expect(ir.meta.format).toBe("odt");
    expect(ir.meta.title).toBe("Title");
    expect(ir.outline).toEqual([
      { id: "h0", level: 1, title: "Title", kind: "section" },
      { id: "h1", level: 2, title: "Sub", kind: "section" },
    ]);
    expect(ir.blocks.filter((b) => b.kind === "heading")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "heading", level: 2, text: "Sub" },
    ]);
  });

  it("абзац, список (ordered:false), таблица table:table", async () => {
    const ir = await odtHandler.parse(ctx(), src(bytes, "doc.odt"));
    expect(ir.blocks).toContainEqual({ kind: "paragraph", text: "Hello world" });
    expect(ir.blocks).toContainEqual({ kind: "list", ordered: false, items: ["one", "two"] });
    const table = ir.blocks.find((b) => b.kind === "table");
    if (!table || table.kind !== "table") throw new Error("expect table");
    expect(table.table.caption).toBe("T1");
    expect(table.table.header).toEqual(["H1", "H2"]);
    expect(table.table.rows).toEqual([["a", "b"]]);
  });

  it("повтор ячеек table:number-columns-repeated разворачивается (ODT)", async () => {
    const b = buildOdt([
      {
        kind: "table",
        name: "R",
        rows: [[{ text: "h" }, { text: "x", colsRepeated: 2 }], ["v"]],
      },
    ]);
    const ir = await odtHandler.parse(ctx(), src(b, "doc.odt"));
    const table = ir.blocks.find((x) => x.kind === "table");
    if (!table || table.kind !== "table") throw new Error("expect table");
    expect(table.table.header).toEqual(["h", "x", "x"]);
    expect(table.table.rows).toEqual([["v"]]);
  });

  it("без content.xml → degraded (INV-D5)", async () => {
    const ir = await odtHandler.parse(ctx(), src(buildOdt([], { skipContent: true }), "e.odt"));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("пустой office:text → degraded", async () => {
    const ir = await odtHandler.parse(ctx(), src(buildOdt([]), "e.odt"));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });
});

describe("pptxHandler", () => {
  const bytes = buildPptx([
    [["Title slide"], ["Body line"]],
    [["Ti", "tle two"]],
    [],
  ]);

  it("слайды в числовом порядке: outline kind=slide + paragraph, meta.pages", async () => {
    const ir = await pptxHandler.parse(ctx(), src(bytes, "deck.pptx"));
    expect(ir.meta.format).toBe("pptx");
    expect(ir.meta.title).toBe("deck.pptx");
    expect(ir.meta.pages).toBe(3);
    expect(ir.outline).toEqual([
      { id: "slide:1", level: 1, title: "Title slide", kind: "slide" },
      { id: "slide:2", level: 1, title: "Title two", kind: "slide" },
      { id: "slide:3", level: 1, title: "Slide 3", kind: "slide" },
    ]);
  });

  it("раны a:t склеиваются, текст слайда — в paragraph-блоке", async () => {
    const ir = await pptxHandler.parse(ctx(), src(bytes, "deck.pptx"));
    expect(ir.blocks).toEqual([
      { kind: "paragraph", text: "Title slide\nBody line" },
      { kind: "paragraph", text: "Title two" },
    ]);
    expect(ir.meta.degraded).toBeUndefined();
  });

  it("нет частей слайдов → degraded, без исключения (INV-D5)", async () => {
    const ir = await pptxHandler.parse(ctx(), src(buildPptx([], { skipSlides: true }), "d.pptx"));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.meta.pages).toBe(0);
    expect(ir.blocks).toEqual([]);
  });

  it("detect проходит только на ZIP-magic", () => {
    expect(pptxHandler.detect?.(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(pptxHandler.detect?.(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
  });
});
