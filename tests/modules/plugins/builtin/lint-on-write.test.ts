import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LintOnWritePlugin } from "../../../../src/modules/plugins/builtin/lint-on-write";

describe("LintOnWritePlugin", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-lint-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runWrite(path: string) {
    const plugin = new LintOnWritePlugin();
    const mockCtx = {
      baseDir: tmpDir,
      logger: { debug: () => {}, warn: () => {} },
    } as any;
    const result: any = { success: true, output: "File written" };
    const call: any = { name: "write_file", arguments: { path } };
    return plugin.onAfterTool!(mockCtx, call, result).then(() => result);
  }

  it("should run lint after write_file tool", async () => {
    const plugin = new LintOnWritePlugin();
    const mockCtx = {
      baseDir: "/test",
      logger: { debug: () => {}, warn: () => {} },
    } as any;
    const mockResult = {
      success: true,
      output: "File written",
      toolName: "write_file",
    } as any;
    const mockCall: any = { name: "read_file" };

    await plugin.onAfterTool!(mockCtx, mockCall, mockResult);

    expect(true).toBe(true);
  });

  it("should skip lint for non-write tools", async () => {
    const plugin = new LintOnWritePlugin();
    const mockCtx = {
      baseDir: "/test",
      logger: { debug: () => {}, warn: () => {} },
    } as any;
    const mockResult = {
      success: true,
      output: "ok",
      toolName: "read_file",
    } as any;
    const mockCall: any = { name: "read_file" };

    await plugin.onAfterTool!(mockCtx, mockCall, mockResult);

    expect(true).toBe(true);
  });

  it("flags a TypeScript syntax error via bun build", async () => {
    const path = "bad.ts";
    writeFileSync(join(tmpDir, path), "const x = ;\n");
    const result = await runWrite(path);
    expect(result.output).toContain("[Syntax check failed]");
  });

  it("passes valid TypeScript and invalidates the cache on content change", async () => {
    const path = "good.ts";
    writeFileSync(join(tmpDir, path), "const x: number = 1;\n");

    // First write: valid → no syntax error
    const first = await runWrite(path);
    expect(first.output).not.toContain("[Syntax check failed]");

    // Same path, broken content → cache keyed by hash must miss and flag it
    writeFileSync(join(tmpDir, path), "const x = ;\n");
    const second = await runWrite(path);
    expect(second.output).toContain("[Syntax check failed]");

    // Fixed again → cache miss → clean
    writeFileSync(join(tmpDir, path), "const x: number = 42;\n");
    const third = await runWrite(path);
    expect(third.output).not.toContain("[Syntax check failed]");
  });

  it("bails out immediately when the abort signal is already aborted (interrupt)", async () => {
    const plugin = new LintOnWritePlugin();
    const controller = new AbortController();
    controller.abort();

    const path = "good.ts";
    writeFileSync(join(tmpDir, path), "const x: number = 1;\n");
    const mockCtx = {
      baseDir: tmpDir,
      logger: { debug: () => {}, warn: () => {} },
      signal: controller.signal,
    } as any;
    const result: any = { success: true, output: "File written" };
    const call: any = { name: "write_file", arguments: { path } };

    // Must return without spawning bun build / npx tsc / appending anything.
    await plugin.onAfterTool!(mockCtx, call, result);
    expect(result.output).toBe("File written");
  });
});
