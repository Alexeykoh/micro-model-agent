import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import { MAX_PAGES, pdfHandler } from "../../src/modules/documents/handlers/pdf";
import { buildRegistry } from "../../src/modules/documents/registry";
import type { DocumentIR } from "../../src/modules/documents/ir";
import type { Logger } from "../../src/logger/app-logger";
import { helloPdf, malformedPdf, multiPagePdf, noTextPdf, outlinePdf } from "./fixtures-pdf";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = (limits = DEFAULT_DOC_LIMITS) => ({ logger, limits });
const src = (bytes: Uint8Array, display = "doc.pdf") => ({
  path: display,
  display,
  ext: ".pdf",
  bytes: async () => bytes,
});

/** Весь текст блоков IR (heading/paragraph) — склейка через перевод строки. */
function allText(ir: DocumentIR): string {
  return ir.blocks
    .map((b) => (b.kind === "heading" || b.kind === "paragraph" ? b.text : ""))
    .join("\n");
}

describe("pdfHandler", () => {
  it("текстовый PDF → format/pages, текст «Hello», непустой outline", async () => {
    const bytes = helloPdf();
    const ir = await pdfHandler.parse(ctx(), src(bytes));
    expect(ir.meta.format).toBe("pdf");
    expect(ir.meta.title).toBe("doc.pdf");
    expect(ir.meta.pages).toBe(1);
    expect(ir.meta.bytes).toBe(bytes.length);
    expect(ir.meta.degraded).toBeUndefined();
    expect(allText(ir)).toContain("Hello");
    expect(ir.outline.length).toBeGreaterThan(0);
    expect(ir.outline[0].kind).toBe("section");
    expect(ir.outline[0].level).toBe(1);
  });

  it("PDF без текстового слоя → degraded с причиной, без исключения (INV-D5)", async () => {
    const ir = await pdfHandler.parse(ctx(), src(noTextPdf()));
    expect(ir.meta.pages).toBe(1);
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("многостраничный PDF → meta.pages и текст каждой страницы", async () => {
    const ir = await pdfHandler.parse(ctx(), src(multiPagePdf(["One", "Two", "Three"])));
    expect(ir.meta.pages).toBe(3);
    const text = allText(ir);
    expect(text).toContain("One");
    expect(text).toContain("Two");
    expect(text).toContain("Three");
    expect(ir.outline).toHaveLength(3);
  });

  it("закладки: outline из getOutline() с уровнями (pushOutline)", async () => {
    const ir = await pdfHandler.parse(ctx(), src(outlinePdf()));
    expect(ir.outline.map((n) => [n.title, n.level])).toEqual([
      ["Chapter One", 1],
      ["Chapter Two", 1],
      ["Sub", 2],
    ]);
    expect(ir.outline.every((n) => n.kind === "section")).toBe(true);
  });

  it("страниц > MAX_PAGES → meta.pages истинный, разобраны первые MAX_PAGES (INV-D5)", async () => {
    const total = MAX_PAGES + 5;
    const texts = Array.from({ length: total }, (_, i) => `Page ${i + 1}`);
    const ir = await pdfHandler.parse(ctx(), src(multiPagePdf(texts)));
    expect(ir.meta.pages).toBe(total);
    expect(ir.blocks).toHaveLength(MAX_PAGES);
    expect(ir.outline).toHaveLength(MAX_PAGES);
    expect(ir.meta.degraded?.reason).toBeTruthy();
  });

  it("битый PDF → parse бросает (fail-open — задача тула, INV-D5)", async () => {
    await expect(pdfHandler.parse(ctx(), src(malformedPdf()))).rejects.toThrow();
  });

  it("detect проходит по %PDF- magic и не проходит по ZIP", () => {
    const pdf = new TextEncoder().encode("%PDF-1.4");
    expect(pdfHandler.detect?.(pdf)).toBe(true);
    expect(pdfHandler.detect?.(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
  });

  it(".pdf резолвится в pdf при включённой группе pdf (реестр)", () => {
    const reg = buildRegistry({ enabled: true, groups: ["pdf"], handlers: [pdfHandler] });
    const magic = new TextEncoder().encode("%PDF-");
    expect(reg.resolve("a.pdf", magic)?.id).toBe("pdf");
    expect(reg.active().groups).toContain("pdf");
  });
});
