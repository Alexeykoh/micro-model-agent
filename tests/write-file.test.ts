import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileTool } from "../src/tools/write-file";
import { ToolRegistry } from "../src/tools/registry";
import { ToolExecutor } from "../src/tools/executor";

/** Исполняет write_file через реальный путь (`execute`) — политику путей
 *  применяет именно он (INV-10), а не хендлер. */
function executorFor(ctx: unknown): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(writeFileTool, "core");
  return new ToolExecutor(registry, ctx as never, { getAllPlugins: () => [] });
}

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

  it("blocks a path outside the base directory (via execute, INV-10)", async () => {
    const result = await executorFor(ctx).execute({
      id: "1",
      name: "write_file",
      arguments: { path: "../outside.txt", content: "x" },
    });
    expect(result.blocked).toBe(true);
  });

  it("blocks a protected file and leaves it untouched (via execute)", async () => {
    const envPath = join(tmpDir, ".env");
    writeFileSync(envPath, "SECRET=1");
    const result = await executorFor(ctx).execute({
      id: "1",
      name: "write_file",
      arguments: { path: envPath, content: "SECRET=2" },
    });
    expect(result.blocked).toBe(true);
    expect(result.output).toContain("Protected path");
    expect(readFileSync(envPath, "utf-8")).toBe("SECRET=1");
  });

  it("blocks files under .git/ (via execute)", async () => {
    const result = await executorFor(ctx).execute({
      id: "1",
      name: "write_file",
      arguments: { path: join(tmpDir, ".git", "config"), content: "x" },
    });
    expect(result.blocked).toBe(true);
    expect(result.output).toContain(".git/");
  });
});
