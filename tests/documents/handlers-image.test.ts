import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import { imageHandler } from "../../src/modules/documents/handlers/image";
import { buildRegistry } from "../../src/modules/documents/registry";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: DEFAULT_DOC_LIMITS };
const src = (path: string, bytes: Uint8Array) => ({
  path,
  display: path,
  ext: path.slice(path.lastIndexOf(".")).toLowerCase(),
  bytes: async () => bytes,
});

/** Magic-байты растровых форматов (только значимая голова + хвост). */
const small = (head: number[]): Uint8Array => new Uint8Array([...head, ...Array(16).fill(0)]);

const PNG = small([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = small([0xff, 0xd8, 0xff, 0xe0]);
const GIF = small([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const BMP = small([0x42, 0x4d]);
/** RIFF....WEBP: 4 байта RIFF, 4 байта размера, "WEBP". */
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe("imageHandler: magic-detect", () => {
  it.each([
    [".png", PNG],
    [".jpg", JPEG],
    [".jpeg", JPEG],
    [".gif", GIF],
    [".webp", WEBP],
    [".bmp", BMP],
  ])("распознаёт %s по содержимому", (ext, bytes) => {
    expect(imageHandler.detect?.(bytes)).toBe(true);
  });

  it("не признаёт чужой контент (ZIP) изображением", () => {
    expect(imageHandler.detect?.(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
  });

  it("WEBP при обрезанной до 8 байт голове доверяет RIFF+расширению", () => {
    expect(imageHandler.detect?.(WEBP.slice(0, 8))).toBe(true);
  });
});

describe("imageHandler: parse → DocumentIR", () => {
  it("даёт figure-блок с raster-фигурой, MIME и размером", async () => {
    const ir = await imageHandler.parse(ctx, src("pic.png", PNG));
    const fig = ir.blocks.find((b) => b.kind === "figure");
    if (!fig || fig.kind !== "figure") throw new Error("expect figure");
    expect(fig.ref.kind).toBe("raster");
    expect(fig.ref.mime).toBe("image/png");
    expect(fig.ref.bytes).toBe(PNG.length);
    expect(fig.ref.note).toBe("raster");
  });

  it.each([
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
    [".bmp", "image/bmp"],
  ])("MIME по расширению %s → %s", async (ext, mime) => {
    const ir = await imageHandler.parse(ctx, src(`p${ext}`, PNG));
    const fig = ir.blocks.find((b) => b.kind === "figure");
    if (!fig || fig.kind !== "figure") throw new Error("expect figure");
    expect(fig.ref.mime).toBe(mime);
  });

  it("формат, заголовок и outline берутся из источника", async () => {
    const ir = await imageHandler.parse(ctx, src("pic.png", PNG));
    expect(ir.meta.format).toBe("png");
    expect(ir.meta.title).toBe("pic.png");
    expect(ir.outline).toHaveLength(1);
    expect(ir.outline[0].kind).toBe("section");
    expect(ir.outline[0].title).toBe("pic.png");
  });

  it("текст из изображения не извлекается", async () => {
    const ir = await imageHandler.parse(ctx, src("pic.png", PNG));
    expect(ir.blocks.every((b) => b.kind === "figure")).toBe(true);
  });
});

describe("imageHandler: реестр (группа image)", () => {
  it(".png с PNG-magic резолвится в image под группой image", () => {
    const reg = buildRegistry({ enabled: true, groups: ["image"], handlers: [imageHandler] });
    expect(reg.resolve("a.png", PNG)?.id).toBe("image");
  });

  it(".png с чужим содержимым не резолвится", () => {
    const reg = buildRegistry({ enabled: true, groups: ["image"], handlers: [imageHandler] });
    expect(reg.resolve("a.png", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
  });
});
