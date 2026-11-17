import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectMime,
  loadFileAsDataUrl,
  sniffImageMime,
  UnsupportedImageError,
} from "../src/llm/image-utils";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dirname || process.cwd(), "_test_image_utils");

/** Минимальный валидный PNG 16×16 — декодируется Bun.Image и провайдером. */
const PNG_16 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR42u3NMQEAAAgDoC251a3gLwqgOXF3VwEBAQEBAQEBAQEBAQEBAQGwF2J8AAG3H2jHAAAAAElFTkSuQmCC",
  "base64",
);

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("image-utils", () => {
  describe("detectMime", () => {
    it("should detect PNG", () => {
      expect(detectMime("photo.png")).toBe("image/png");
    });

    it("should detect JPEG", () => {
      expect(detectMime("photo.jpg")).toBe("image/jpeg");
      expect(detectMime("photo.jpeg")).toBe("image/jpeg");
    });

    it("should detect GIF", () => {
      expect(detectMime("anim.gif")).toBe("image/gif");
    });

    it("should detect WebP", () => {
      expect(detectMime("image.webp")).toBe("image/webp");
    });

    it("should default to PNG for unknown extension", () => {
      expect(detectMime("image.xyz")).toBe("image/png");
    });

    it("should handle uppercase extensions", () => {
      expect(detectMime("PHOTO.PNG")).toBe("image/png");
      expect(detectMime("PHOTO.JPG")).toBe("image/jpeg");
    });
  });

  describe("sniffImageMime", () => {
    it("recognises the raster formats models accept", () => {
      expect(sniffImageMime(PNG_16)).toBe("image/png");
      expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
      expect(sniffImageMime(Buffer.from("GIF89a.......", "latin1"))).toBe("image/gif");
      expect(sniffImageMime(Buffer.from("RIFF0000WEBPVP8 ", "latin1"))).toBe("image/webp");
      expect(sniffImageMime(Buffer.from("BM000000", "latin1"))).toBe("image/bmp");
    });

    it("returns undefined for SVG and non-images", () => {
      expect(sniffImageMime(SVG)).toBeUndefined();
      expect(sniffImageMime(Buffer.from("hello world"))).toBeUndefined();
    });
  });

  describe("loadFileAsDataUrl", () => {
    it("should load a raster file as data URL", async () => {
      const filePath = join(TEST_DIR, "test.png");
      writeFileSync(filePath, PNG_16);

      const result = await loadFileAsDataUrl(filePath);
      expect(result.dataUrl).toMatch(/^data:image\/(png|jpeg);base64,/);
      const b64 = result.dataUrl.slice(result.dataUrl.indexOf(",") + 1);
      expect(Buffer.from(b64, "base64").length).toBeGreaterThan(0);
    });

    it("should throw for non-existent file", async () => {
      await expect(loadFileAsDataUrl(join(TEST_DIR, "nope.png"))).rejects.toThrow();
    });

    it("rejects SVG instead of labelling it image/png", async () => {
      const filePath = join(TEST_DIR, "meme.svg");
      writeFileSync(filePath, SVG);

      await expect(loadFileAsDataUrl(filePath)).rejects.toBeInstanceOf(UnsupportedImageError);
      await expect(loadFileAsDataUrl(filePath)).rejects.toThrow(/Svg|svg/i);
    });

    it("rejects non-image bytes even with an image extension", async () => {
      const filePath = join(TEST_DIR, "fake.png");
      writeFileSync(filePath, Buffer.from("not an image"));

      await expect(loadFileAsDataUrl(filePath)).rejects.toBeInstanceOf(UnsupportedImageError);
    });
  });
});
