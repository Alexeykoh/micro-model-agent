import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { loadIgnoreMatcher } from "../../../src/modules/indexer/gitignore";

function matcherFor(files: Record<string, string>) {
  return loadIgnoreMatcher("/repo", (path) => {
    const name = path.replace(/^\/repo\//, "");
    return files[name] ?? null;
  });
}

describe("loadIgnoreMatcher", () => {
  it("ignores a directory pattern at any depth and its contents", () => {
    const m = matcherFor({ ".gitignore": "node_modules\nbuild/\n" });
    expect(m.ignores("node_modules", true)).toBe(true);
    expect(m.ignores("packages/app/node_modules", true)).toBe(true);
    expect(m.ignores("node_modules/pkg/index.js", false)).toBe(true);
    expect(m.ignores("build", true)).toBe(true);
    expect(m.ignores("src/build.ts", false)).toBe(false);
  });

  it("honors root anchoring and globs", () => {
    const m = matcherFor({ ".gitignore": "/dist\n*.log\n!keep.log\n" });
    expect(m.ignores("dist", true)).toBe(true);
    expect(m.ignores("src/dist", false)).toBe(false);
    expect(m.ignores("debug.log", false)).toBe(true);
    expect(m.ignores("keep.log", false)).toBe(false);
  });

  it("treats a bare name as matching any path segment", () => {
    const m = matcherFor({ ".gitignore": "coverage\n" });
    expect(m.ignores("a/b/coverage", true)).toBe(true);
    expect(m.ignores("a/b/coverage/report.html", false)).toBe(true);
    expect(m.ignores("coverage.ts", false)).toBe(false);
  });

  it("merges .mmaignore after .gitignore", () => {
    const m = matcherFor({ ".gitignore": "generated\n", ".mmaignore": "!generated\n" });
    expect(m.ignores("generated", true)).toBe(false);
  });

  it("is fail-open when no ignore files exist", () => {
    const m = matcherFor({});
    expect(m.ignores("anything", false)).toBe(false);
  });

  it("reads real files from disk", () => {
    const m = loadIgnoreMatcher(join(process.cwd(), "does-not-exist"), () => readFileSync("nope", "utf-8"));
    expect(m.ignores("x", false)).toBe(false);
  });
});
