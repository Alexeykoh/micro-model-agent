import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileTool } from "../src/tools/write-file";

describe("write_file", () => {
  let tmpDir: string;
  let ctx: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));
    ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } };
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true });
  });

  it("should write file content", async () => {
    const result = await writeFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
      content: "hello",
    });
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpDir, "test.txt"), "utf-8")).toBe("hello");
  });

  it("should create intermediate directories", async () => {
    const result = await writeFileTool.handler(ctx, {
      path: join(tmpDir, "a/b/c/test.txt"),
      content: "nested",
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(tmpDir, "a/b/c/test.txt"))).toBe(true);
  });

  it("should overwrite existing file", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "old");
    await writeFileTool.handler(ctx, { path: join(tmpDir, "test.txt"), content: "new" });
    expect(readFileSync(join(tmpDir, "test.txt"), "utf-8")).toBe("new");
  });

  it("should enforce path safety", async () => {
    const result = await writeFileTool.handler(ctx, { path: "../outside.txt", content: "x" });
    expect(result.success).toBe(false);
  });
});
