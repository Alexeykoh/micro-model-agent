import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readFileTool } from "../src/tools/read-file";

describe("read_file", () => {
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

  it("reads a slice of a large file correctly (bounded read)", async () => {
    const bigPath = join(tmpDir, "big.txt");
    const total = 20000;
    const lines: string[] = [];
    for (let i = 1; i <= total; i++) lines.push(`line-${i}`);
    writeFileSync(bigPath, lines.join("\n"), "utf-8");

    const result = await readFileTool.handler(ctx, { path: "big.txt", offset: 10001, limit: 50 });
    expect(result.success).toBe(true);
    expect(result.output).toContain("line-10001");
    expect(result.output).toContain("line-10050");
    expect(result.output).not.toContain("line-10051");
    expect(result.output).toContain(String(total));

    const first = await readFileTool.handler(ctx, { path: "big.txt", limit: 10 });
    expect(first.output).toContain("line-1\n");
  });

  it("streams files over the 1MB threshold with correct totals", async () => {
    const bigPath = join(tmpDir, "huge.txt");
    const total = 120000; // ~1.4MB
    const parts: string[] = [];
    for (let i = 1; i <= total; i++) parts.push(`line-${i}`);
    writeFileSync(bigPath, parts.join("\n"), "utf-8");

    const result = await readFileTool.handler(ctx, { path: "huge.txt", offset: 119991, limit: 5 });
    expect(result.success).toBe(true);
    expect(result.output).toContain("line-119991");
    expect(result.output).toContain("line-119995");
    expect(result.output).toContain(String(total));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      for (const f of ["test.txt", "empty.txt", "big.txt", "huge.txt"]) {
        const p = join(tmpDir, f);
        if (existsSync(p)) unlinkSync(p);
      }
      rmdirSync(tmpDir);
    }
  });

  it("should read file content", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "hello world");
    const result = await readFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello world");
  });

  it("should include full path and format in output header", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "hello world");
    const result = await readFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain(join(tmpDir, "test.txt"));
    expect(result.output).toContain(".txt");
    expect(result.output).toContain("lines 1-1");
  });

  it("should read with offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(tmpDir, "test.txt"), lines);
    const result = await readFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
      offset: 3,
      limit: 2,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("line 3");
    expect(result.output).toContain("line 4");
    expect(result.output).toContain("lines 3-4");
  });

  it("should chunk long files by default and suggest offset continuation", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(tmpDir, "test.txt"), lines);
    const result = await readFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("line 1");
    expect(result.output).toContain("line 300");
    expect(result.output).not.toContain("line 301");
    expect(result.output).toContain("offset=301");
    expect(result.output).toContain("1000 lines");
  });

  it("should read a whole small file in a single default call (no offset hint)", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(tmpDir, "test.txt"), lines);
    const result = await readFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("line 50");
    expect(result.output).not.toContain("offset=");
  });

  it("should not truncate when explicit limit covers the file", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(tmpDir, "test.txt"), lines);
    const result = await readFileTool.handler(ctx, {
      path: join(tmpDir, "test.txt"),
      limit: 100,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("line 50");
    expect(result.output).not.toContain("offset=");
  });

  it("should handle nonexistent file", async () => {
    const result = await readFileTool.handler(ctx, {
      path: join(tmpDir, "nope.txt"),
    });
    expect(result.success).toBe(false);
  });

  it("should show the resolved path for a missing relative path", async () => {
    const result = await readFileTool.handler(ctx, {
      path: "nope-relative.txt",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("resolved to");
    expect(result.output).toContain("nope-relative.txt");
  });

  it("should enforce path safety", async () => {
    const result = await readFileTool.handler(ctx, { path: "../etc/passwd" });
    expect(result.success).toBe(false);
  });
});
