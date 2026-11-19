import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Indexer } from "../../../src/modules/indexer/walker";

let tempDir: string | null = null;

function project(): string {
  tempDir = mkdtempSync(join(tmpdir(), "mma-incr-"));
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(join(tempDir, "src/a.ts"), "export const a = 1");
  writeFileSync(join(tempDir, "src/b.ts"), "export const b = 2");
  return tempDir;
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("Indexer incremental walk", () => {
  it("records mtime and symbols on every file", async () => {
    const dir = project();
    const result = await new Indexer(dir).walk();
    for (const f of result.files) {
      expect(typeof f.mtimeMs).toBe("number");
      expect(Array.isArray(f.symbols)).toBe(true);
    }
  });

  it("reuses unchanged files and re-reads only changed ones", async () => {
    const dir = project();
    const first = await new Indexer(dir).walk();
    const aFirst = first.files.find((f) => f.path.endsWith("a.ts"))!;
    const bFirst = first.files.find((f) => f.path.endsWith("b.ts"))!;

    // Bump mtime past filesystem resolution, then change only a.ts.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1\nexport function fresh() {}");

    const second = await new Indexer(dir).walk(first);
    const aSecond = second.files.find((f) => f.path.endsWith("a.ts"))!;
    const bSecond = second.files.find((f) => f.path.endsWith("b.ts"))!;

    // a.ts re-read: new symbol visible.
    expect(aSecond.exports).toContain("fresh");
    // b.ts reused: same mtime and identical exports.
    expect(bSecond.mtimeMs).toBe(bFirst.mtimeMs);
    expect(bSecond.exports).toEqual(bFirst.exports);
    expect(aSecond.mtimeMs).not.toBe(aFirst.mtimeMs);
  });

  it("drops files that disappeared from a previous index", async () => {
    const dir = project();
    const first = await new Indexer(dir).walk();
    rmSync(join(dir, "src", "b.ts"));
    const second = await new Indexer(dir).walk(first);
    expect(second.files.map((f) => f.path.replace(/\\/g, "/"))).toEqual(["src/a.ts"]);
  });
});
