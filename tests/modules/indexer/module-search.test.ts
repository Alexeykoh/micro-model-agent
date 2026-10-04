import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { IndexerModule } from "../../../src/modules/indexer/module";
import { setLocale } from "../../../src/i18n/index";

let tmpDir: string;

beforeEach(() => {
  setLocale("en");
  tmpDir = mkdtempSync(join(tmpdir(), "mma-modsearch-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = join(tmpDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

async function runAction(action: string, query?: string) {
  const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
  await mod.buildIndex();
  return mod.getToolDefinitions()[0].handler({} as never, { action, query });
}

describe("project_map search actions", () => {
  it("symbol action returns definition sites with line and kind", async () => {
    write("src/registry.ts", "export function registerThing() {}\nexport const other = 1;");
    const res = await runAction("symbol", "registerThing");
    expect(res.success).toBe(true);
    expect(res.output).toContain("registerThing");
    expect(res.output).toContain(":1");
    expect(res.output).toContain("(function)");
  });

  it("outline action lists a file's symbols by line", async () => {
    write("src/mod.ts", "export const a = 1;\nexport class B {}\n");
    const res = await runAction("outline", "mod.ts");
    expect(res.success).toBe(true);
    expect(res.output).toContain("src/mod.ts");
    expect(res.output).toMatch(/1: a \(const\)/);
    expect(res.output).toMatch(/2: B \(class\)/);
  });

  it("requires a query for symbol/outline", async () => {
    write("src/a.ts", "export const a = 1");
    const res = await runAction("symbol");
    expect(res.success).toBe(false);
  });

  it("marks the map as truncated when the file cap is hit", async () => {
    write("src/a.ts", "export const a = 1");
    write("src/b.ts", "export const b = 1");
    write("src/c.ts", "export const c = 1");
    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma"), maxFiles: 2 });
    await mod.buildIndex();
    expect(mod.getPromptMap()).toContain("[!]");
  });

  it("falls back to an external symbol provider when the index has no match", async () => {
    write("src/a.ts", "export const a = 1");
    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    mod.setSymbolProvider(async () => [
      { path: "src/elsewhere.ts", line: 12, name: "ghost", kind: "class" },
    ]);
    await mod.buildIndex();
    const res = await mod.getToolDefinitions()[0].handler({} as never, {
      action: "symbol",
      query: "ghost",
    });
    expect(res.success).toBe(true);
    expect(res.output).toContain("src/elsewhere.ts:12 ghost (class)");
  });

  it("prefers the index over the provider and survives provider errors", async () => {
    write("src/a.ts", "export function known() {}");
    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    let called = false;
    mod.setSymbolProvider(async () => {
      called = true;
      return [];
    });
    await mod.buildIndex();
    const res = await mod.getToolDefinitions()[0].handler({} as never, {
      action: "symbol",
      query: "known",
    });
    expect(res.output).toContain("(function)");
    expect(called).toBe(false);
  });

  it("respects .gitignore when configured", async () => {
    write(".gitignore", "generated/\n");
    write("generated/skip.ts", "export const skip = 1");
    write("src/keep.ts", "export const keep = 1");
    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    await mod.buildIndex();
    const map = mod.getPromptMap() ?? "";
    expect(map).toContain("keep.ts");
    expect(map).not.toContain("skip.ts");
  });
});
