import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { attachImageTool } from "../src/tools/attach-image";
import { ContextManager } from "../src/modules/context/manager";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import type { ToolContext } from "../src/tools/types";

const TEST_DIR = join(import.meta.dirname || process.cwd(), "_test_attach_image");

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  const cm = new ContextManager(128000);
  return {
    config: {} as any,
    baseDir: TEST_DIR,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    contextManager: cm,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("attach_image tool", () => {
  it("should return error when source is empty", async () => {
    const ctx = makeCtx();
    const result = await attachImageTool.handler(ctx, {});
    expect(result.success).toBe(false);
  });

  it("should return error when file not found", async () => {
    const ctx = makeCtx();
    const result = await attachImageTool.handler(ctx, { source: "nonexistent.png" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("should load a local PNG file", async () => {
    // Create a minimal valid PNG (1x1 pixel)
    const pngBuf = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52, // IHDR chunk
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
      0x90,
      0x77,
      0x53,
      0xde,
      0x00,
      0x00,
      0x00,
      0x0c,
      0x49,
      0x44,
      0x41, // IDAT chunk
      0x54,
      0x08,
      0xd7,
      0x63,
      0xf8,
      0xcf,
      0xc0,
      0x00,
      0x00,
      0x00,
      0x02,
      0x00,
      0x01,
      0xe2,
      0x21,
      0xbc,
      0x33,
      0x00,
      0x00,
      0x00,
      0x00,
      0x49,
      0x45,
      0x4e, // IEND chunk
      0x44,
      0xae,
      0x42,
      0x60,
      0x82,
    ]);
    const filePath = join(TEST_DIR, "test.png");
    writeFileSync(filePath, pngBuf);

    const ctx = makeCtx();
    const result = await attachImageTool.handler(ctx, { source: "test.png" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("attached");

    // Verify the image was queued on the context manager
    expect(ctx.contextManager!.hasPendingImages()).toBe(true);
  });

  it("should load a JPEG file", async () => {
    // Minimal JPEG: SOI marker + APP0 + EOI
    const jpgBuf = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);
    const filePath = join(TEST_DIR, "test.jpg");
    writeFileSync(filePath, jpgBuf);

    const ctx = makeCtx();
    const result = await attachImageTool.handler(ctx, { source: "test.jpg" });
    expect(result.success).toBe(true);
  });

  it("should return error when no context manager", async () => {
    const filePath = join(TEST_DIR, "test.png");
    writeFileSync(filePath, Buffer.from("fake"));

    const ctx = makeCtx({ contextManager: undefined });
    const result = await attachImageTool.handler(ctx, { source: "test.png" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("context");
  });

  it("should return error for invalid URL", async () => {
    const ctx = makeCtx();
    const result = await attachImageTool.handler(ctx, {
      source: "https://invalid.example.com/nonexistent.png",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Failed to load");
  });

  it("should have correct tool definition", () => {
    expect(attachImageTool.name).toBe("attach_image");
    expect(attachImageTool.tags).toContain("vision");
    expect(attachImageTool.parameters.required).toEqual(["source"]);
  });
});
