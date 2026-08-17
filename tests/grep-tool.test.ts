import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { grepTool } from "../src/tools/grep-tool";

describe("grep", () => {
  let tmpDir: string;
  let ctx: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));
    ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } };
    writeFileSync(join(tmpDir, "test.txt"), "hello world\nfoo bar");
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true });
  });

  it("should find matching lines", async () => {
    const result = await grepTool.handler(ctx, { pattern: "hello" });
    expect(result.success).toBe(true);
  });

  it("should handle regex alternation (|) without shell interference", async () => {
    writeFileSync(join(tmpDir, "code.ts"), "// TODO: fix\nconst foo = 1\n// FIXME: here");
    const result = await grepTool.handler(ctx, { pattern: "TODO|FIXME", include: "*.ts" });
    expect(result.success).toBe(true);
    const output = String(result.output);
    expect(output).toContain("TODO");
    expect(output).toContain("FIXME");
  });

  it("should return no matches for absent pattern", async () => {
    const result = await grepTool.handler(ctx, { pattern: "nonexistent-string-xyz" });
    expect(result.success).toBe(true);
  });
});
