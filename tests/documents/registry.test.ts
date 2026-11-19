import { describe, expect, it } from "vitest";
import { buildRegistry } from "../../src/modules/documents/registry";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: { maxLines: 100, maxChars: 5000, maxTableRows: 10 } };
const src = (path: string, text: string) => ({ path, display: path, ext: path.slice(path.lastIndexOf(".")), bytes: async () => new TextEncoder().encode(text) });

describe("DocumentRegistry", () => {
  it("resolve по расширению", () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    expect(reg.resolve("a.csv", new Uint8Array([0x61]))?.id).toBe("csv");
  });
  it("parse отдаёт DocumentIR", async () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    const ir = await reg.parse(ctx, src("a.csv", "a,b\n1,2"));
    expect(ir.meta.format).toBe("csv");
  });
  it("неизвестный путь — null", () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    expect(reg.resolve("a.bin", new Uint8Array([0x00]))).toBeNull();
  });
  it("detect отменяет совпадение по расширению (контент важнее)", () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    // .csv, но ZIP-magic: detect csv (head === unknown) не проходит → null
    expect(reg.resolve("a.csv", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
  });
  it("parse не зависит от this (деструктуризация безопасна)", async () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    const { parse, resolve } = reg;
    expect(resolve("a.csv", new Uint8Array([0x61]))?.id).toBe("csv");
    const ir = await parse(ctx, src("a.csv", "a,b\n1,2"));
    expect(ir.meta.format).toBe("csv");
  });
  it("ZIP-файл .xlsx резолвится в xlsx при включённой группе spreadsheet (W2)", () => {
    const reg = buildRegistry();
    expect(reg.resolve("book.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))?.id).toBe("xlsx");
    expect(reg.active().groups).toContain("spreadsheet");
  });
  it("ZIP-файлы .ods/.docx/.odt/.pptx резолвятся в свои обработчики при группе office (W2b)", () => {
    const reg = buildRegistry();
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(reg.resolve("a.ods", zip)?.id).toBe("ods");
    expect(reg.resolve("a.docx", zip)?.id).toBe("docx");
    expect(reg.resolve("a.odt", zip)?.id).toBe("odt");
    expect(reg.resolve("a.pptx", zip)?.id).toBe("pptx");
    expect(reg.active().groups).toContain("office");
  });
  it(".pdf с %PDF--magic резолвится в pdf при группе pdf (W3)", () => {
    const reg = buildRegistry();
    const magic = new TextEncoder().encode("%PDF-");
    expect(reg.resolve("a.pdf", magic)?.id).toBe("pdf");
    expect(reg.active().groups).toContain("pdf");
  });
  it(".png с PNG-magic резолвится в image при группе image (W4)", () => {
    const reg = buildRegistry();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(reg.resolve("a.png", png)?.id).toBe("image");
    expect(reg.active().groups).toContain("image");
  });
  it(".geojson и .gpx резолвятся под группой geo (W4)", () => {
    const reg = buildRegistry();
    expect(reg.resolve("a.geojson", new Uint8Array([0x7b]))?.id).toBe("geojson");
    expect(reg.resolve("a.gpx", new TextEncoder().encode("<?xml"))?.id).toBe("gpx");
    expect(reg.active().groups).toContain("geo");
  });
});
