import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLedger } from "../../src/core/context/ledger";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-led-"));
  path = join(dir, "NOTES.md");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ContextLedger", () => {
  it("appends, dedupes and persists across reloads", () => {
    const l = new ContextLedger(path, 200);
    l.record("src/a.ts:10", "found NEEDLE_A_111");
    l.record("src/a.ts:10", "found NEEDLE_A_111");
    l.record("src/b.ts:5", "other");
    expect(l.size()).toBe(2);
    expect(existsSync(path)).toBe(true);
    const reloaded = new ContextLedger(path, 200);
    reloaded.load();
    expect(reloaded.size()).toBe(2);
    expect(reloaded.render()).toContain("src/a.ts:10");
    expect(readFileSync(path, "utf8")).toContain("src/a.ts:10");
  });

  it("marks a path stale on change and reports staleness", () => {
    const l = new ContextLedger(path, 200);
    l.record("src/a.ts:10", "fact");
    l.markStale("src/a.ts");
    expect(l.isStale("src/a.ts:10")).toBe(true);
    expect(l.render()).toContain("(stale)");
  });

  it("caps entries by folding the oldest into a per-file index", () => {
    const l = new ContextLedger(path, 3);
    for (let i = 0; i < 6; i++) l.record(`f${i}.ts:${i}`, `n${i}`);
    expect(l.size()).toBeLessThanOrEqual(3); // cap
    expect(l.render()).toContain("index");
  });

  it("pointerLine reports the path and count", () => {
    const l = new ContextLedger(path, 200);
    l.record("x.ts:1", "n");
    expect(l.pointerLine()).toMatch(/^\[Notes: .*NOTES\.md, 1\]$/);
  });
});
