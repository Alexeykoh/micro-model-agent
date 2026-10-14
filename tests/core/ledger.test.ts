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

  it("load is last-wins: an updated note supersedes the earlier one", () => {
    const l = new ContextLedger(path, 200);
    l.record("a.ts:1", "old");
    l.record("a.ts:1", "NEW");
    const reloaded = new ContextLedger(path, 200);
    reloaded.load();
    expect(reloaded.size()).toBe(1);
    expect(reloaded.render()).toContain("NEW");
    expect(reloaded.render()).not.toContain("old");
  });

  it("persists staleness marks across reloads", () => {
    const l = new ContextLedger(path, 200);
    l.record("b.ts:2", "fact");
    l.markStale("b.ts");
    const reloaded = new ContextLedger(path, 200);
    reloaded.load();
    expect(reloaded.isStale("b.ts:2")).toBe(true);
    expect(reloaded.render()).toContain("(stale)");
  });

  it("re-applies the cap on load (in memory, no rewrite)", () => {
    const l = new ContextLedger(path, 3);
    for (let i = 0; i < 6; i++) l.record(`g${i}.ts:${i}`, `n${i}`);
    const reloaded = new ContextLedger(path, 3);
    reloaded.load();
    expect(reloaded.size()).toBe(3);
    expect(reloaded.render()).toContain("[index]");
    expect(reloaded.pointerLine()).toContain(", 3]");
  });

  it("derives correct file prefixes for Windows paths and URLs", () => {
    const l = new ContextLedger(path, 1);
    l.record("C:\\proj\\src\\a.ts:10", "win");
    l.record("https://example.com/p#sec", "web");
    l.record("third.ts:3", "third");
    const rendered = l.render();
    const index = rendered.split("\n").find((line) => line.startsWith("[index]")) ?? "";
    expect(index).toContain("C:\\proj\\src\\a.ts");
    expect(index).toContain("https://example.com/p");
    expect(index).not.toContain("C,");
    expect(index).not.toContain("https,");
  });

  it("keeps a cumulative fold index across multiple folds", () => {
    const l = new ContextLedger(path, 1);
    l.record("one.ts:1", "a");
    l.record("two.ts:2", "b");
    l.record("three.ts:3", "c");
    const index = l.render().split("\n").find((line) => line.startsWith("[index]")) ?? "";
    expect(index).toContain("one.ts");
    expect(index).toContain("two.ts");
    expect(index).not.toContain("three.ts");
  });

  it("double load() is idempotent", () => {
    const l = new ContextLedger(path, 3);
    for (let i = 0; i < 6; i++) l.record(`h${i}.ts:${i}`, `n${i}`);
    const reloaded = new ContextLedger(path, 3);
    reloaded.load();
    const sizeBefore = reloaded.size();
    const renderBefore = reloaded.render();
    reloaded.load();
    expect(reloaded.size()).toBe(sizeBefore);
    expect(reloaded.render()).toBe(renderBefore);
  });

  it("does not misread an inline (stale) note as a staleness mark", () => {
    const l = new ContextLedger(path, 200);
    l.record("c.ts:3", "contains (stale) inline");
    expect(l.isStale("c.ts:3")).toBe(false);
    const reloaded = new ContextLedger(path, 200);
    reloaded.load();
    expect(reloaded.isStale("c.ts:3")).toBe(false);
    expect(reloaded.render()).not.toContain("inline (stale)");
    reloaded.markStale("c.ts");
    expect(reloaded.isStale("c.ts:3")).toBe(true);
    expect(reloaded.render()).toContain("inline (stale)");
  });
});
