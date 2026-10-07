// provablyStale: file mtime within the FS-timestamp tolerance of the plan is
// treated as fresh (a file written right after plan creation could get an mtime
// a fraction of a ms *earlier* than createdAt — that must not block auto-advance).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { provablyStale } from "../src/modules/execution/module";

describe("provablyStale", () => {
  let dir: string;
  let file: string;
  const base = Date.now();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-stale-"));
    file = join(dir, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("treats a file older than the plan as stale", () => {
    utimesSync(file, new Date(base - 5000), new Date(base - 5000));
    expect(provablyStale([file], base)).toBe(true);
  });

  it("treats an equal-mtime file as fresh (no 1ms race)", () => {
    utimesSync(file, new Date(base), new Date(base));
    expect(provablyStale([file], base)).toBe(false);
  });

  it("treats a file marginally older than the plan as fresh (timestamp skew)", () => {
    utimesSync(file, new Date(base - 500), new Date(base - 500));
    expect(provablyStale([file], base)).toBe(false);
  });

  it("treats a newer file as fresh", () => {
    utimesSync(file, new Date(base + 5000), new Date(base + 5000));
    expect(provablyStale([file], base)).toBe(false);
  });

  it("returns false for unresolved entries and NaN", () => {
    expect(provablyStale([null], base)).toBe(false);
    expect(provablyStale([file], Number.NaN)).toBe(false);
  });
});
