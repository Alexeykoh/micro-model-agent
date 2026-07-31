import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { moveFileTool } from "../src/tools/move-file";

describe("move_file", () => {
  let tmpDir: string;
  let ctx: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));
    ctx = {
      baseDir: tmpDir,
      config: {},
      logger: { info: () => {}, error: () => {} },
    };
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true });
  });

  it("should rename file within same directory", async () => {
    writeFileSync(join(tmpDir, "old-name.txt"), "test");
    const result = await moveFileTool.handler(ctx, {
      from: "old-name.txt",
      to: "new-name.txt",
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(tmpDir, "old-name.txt"))).toBe(false);
    expect(existsSync(join(tmpDir, "new-name.txt"))).toBe(true);
    expect(readFileSync(join(tmpDir, "new-name.txt"), "utf-8")).toBe("test");
  });

  it("should move file to different directory", async () => {
    writeFileSync(join(tmpDir, "source.txt"), "data");
    const result = await moveFileTool.handler(ctx, {
      from: "source.txt",
      to: "subdir/dest.txt",
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(tmpDir, "source.txt"))).toBe(false);
    expect(existsSync(join(tmpDir, "subdir/dest.txt"))).toBe(true);
    expect(readFileSync(join(tmpDir, "subdir/dest.txt"), "utf-8")).toBe("data");
  });

  it("should fail when source does not exist", async () => {
    const result = await moveFileTool.handler(ctx, {
      from: "nonexistent.txt",
      to: "target.txt",
    });
    expect(result.success).toBe(false);
  });

  it("should enforce path safety for source", async () => {
    const result = await moveFileTool.handler(ctx, {
      from: "../outside.txt",
      to: "safe.txt",
    });
    expect(result.success).toBe(false);
  });

  it("should enforce path safety for destination", async () => {
    writeFileSync(join(tmpDir, "safe.txt"), "x");
    const result = await moveFileTool.handler(ctx, {
      from: "safe.txt",
      to: "../outside.txt",
    });
    expect(result.success).toBe(false);
  });
});
