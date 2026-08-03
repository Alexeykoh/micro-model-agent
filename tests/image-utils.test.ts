import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectMime, loadFileAsDataUrl } from "../src/llm/image-utils";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dirname || process.cwd(), "_test_image_utils");

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

  describe("loadFileAsDataUrl", () => {
    it("should load a file as data URL", () => {
      const buf = Buffer.from("fake image data");
      const filePath = join(TEST_DIR, "test.png");
      writeFileSync(filePath, buf);

      const result = loadFileAsDataUrl(filePath);
      expect(result.dataUrl).toContain("data:image/png;base64,");
      expect(result.mime).toBe("image/png");
      expect(result.resized).toBe(false);
    });

    it("should detect correct MIME from extension", () => {
      const buf = Buffer.from("fake");
      const jpgPath = join(TEST_DIR, "test.jpg");
      writeFileSync(jpgPath, buf);

      const result = loadFileAsDataUrl(jpgPath);
      expect(result.mime).toBe("image/jpeg");
      expect(result.dataUrl).toContain("data:image/jpeg;base64,");
    });

    it("should throw for non-existent file", () => {
      expect(() => loadFileAsDataUrl(join(TEST_DIR, "nope.png"))).toThrow();
    });

    it("should include correct base64 encoding", () => {
      const content = "hello world";
      const filePath = join(TEST_DIR, "test.txt");
      writeFileSync(filePath, content);

      const result = loadFileAsDataUrl(filePath);
      const expectedB64 = Buffer.from(content).toString("base64");
      expect(result.dataUrl).toContain(expectedB64);
    });
  });
});
