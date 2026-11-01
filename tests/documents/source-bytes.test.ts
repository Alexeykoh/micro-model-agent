/**
 * Источник документа обязан отдавать настоящий `Uint8Array`, а не Node `Buffer`:
 * `fs.readFile` возвращает `Buffer`, typecheck этого не видит (`Buffer` —
 * подкласс `Uint8Array`), и pdfjs 6 отвергает `Buffer` явно. Гвард держит границу
 * и сквозной путь «файл на диске → registry.parse → текст PDF».
 */
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import { pdfHandler } from "../../src/modules/documents/handlers/pdf";
import { buildRegistry } from "../../src/modules/documents/registry";
import { fileSource } from "../../src/modules/documents/source";
import type { Logger } from "../../src/logger/app-logger";
import { helloPdf } from "./fixtures-pdf";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: DEFAULT_DOC_LIMITS };

let dir = "";
const pdf = helloPdf();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mma-doc-source-"));
  await writeFile(join(dir, "doc.pdf"), pdf);
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("fileSource: байты документа", () => {
  it("отдаёт не Buffer, а Uint8Array с теми же байтами и длиной", async () => {
    const bytes = await fileSource(dir, "doc.pdf").bytes();
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(pdf.length);
    expect(Array.from(bytes.subarray(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });

  it("читает файл один раз: повторный вызов отдаёт тот же промис", async () => {
    const source = fileSource(dir, "doc.pdf");
    const first = source.bytes();
    expect(source.bytes()).toBe(first);
    expect((await first).length).toBe(pdf.length);
  });

  it("сквозной путь: реальный .pdf с диска разбирается в текст (ловит Buffer у pdfjs)", async () => {
    const registry = buildRegistry({ enabled: true, groups: ["pdf"], handlers: [pdfHandler] });
    const ir = await registry.parse(ctx, fileSource(dir, "doc.pdf"));
    const text = ir.blocks
      .map((b) => (b.kind === "heading" || b.kind === "paragraph" ? b.text : ""))
      .join("\n");
    expect(ir.meta.format).toBe("pdf");
    expect(ir.meta.pages).toBe(1);
    expect(text).toContain("Hello");
  });
});
