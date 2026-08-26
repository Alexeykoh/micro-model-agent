import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { globTool } from "../src/tools/glob-tool";

describe("glob", () => {
  let tmpDir: string;
  let ctx: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));
    ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } };
    writeFileSync(join(tmpDir, "a.ts"), "// a");
    writeFileSync(join(tmpDir, "b.ts"), "// b");
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(join(tmpDir, "sub/c.ts"), "// c");
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true });
  });

  it("should find .ts files", async () => {
    const result = await globTool.handler(ctx, { pattern: "**/*.ts" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("a.ts");
    expect(result.output).toContain("b.ts");
    expect(result.output).toContain("c.ts");
  });
});

describe("glob security (audit 2026-08-26)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-test-"));
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true });
  });

  it("rejects absolute patterns", async () => {
    const ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } };
    const result = await globTool.handler(ctx, { pattern: "/etc/*" });
    expect(result.success).toBe(false);
  });

  it("rejects .. traversal patterns", async () => {
    const ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } };
    const result = await globTool.handler(ctx, { pattern: "../../*" });
    expect(result.success).toBe(false);
  });
});
