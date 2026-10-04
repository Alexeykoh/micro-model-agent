import { describe, it, expect } from "vitest";
import { rankFiles, rankSymbols, matchOutline, matchRank } from "../../../src/modules/indexer/rank";
import type { IndexedFile } from "../../../src/modules/indexer/walker";

function file(over: Partial<IndexedFile> & { path: string }): IndexedFile {
  return {
    language: "typescript",
    exports: [],
    symbols: [],
    size: 1,
    mtimeMs: 1,
    ...over,
  };
}

describe("matchRank", () => {
  it("ranks exact < prefix < substring < none", () => {
    expect(matchRank("foo", "foo")).toBe(0);
    expect(matchRank("foobar", "foo")).toBe(1);
    expect(matchRank("barfoo", "foo")).toBe(2);
    expect(matchRank("baz", "foo")).toBe(-1);
  });
});

describe("rankFiles", () => {
  it("puts a symbol definition ahead of a path-only match", () => {
    const files = [
      file({ path: "src/foo-service.ts" }),
      file({ path: "src/registry.ts", symbols: [{ name: "foo", line: 3, kind: "function" }] }),
    ];
    const ranked = rankFiles(files, "foo");
    expect(ranked[0].file.path).toBe("src/registry.ts");
  });

  it("prefers source over tests over docs at equal rank", () => {
    const files = [
      file({ path: "docs/foo.md", language: "markdown" }),
      file({ path: "tests/foo.test.ts" }),
      file({ path: "src/foo.ts" }),
    ];
    const ranked = rankFiles(files, "foo");
    expect(ranked.map((r) => r.file.path)).toEqual([
      "src/foo.ts",
      "tests/foo.test.ts",
      "docs/foo.md",
    ]);
  });

  it("returns nothing for an empty query or no matches", () => {
    expect(rankFiles([file({ path: "a.ts" })], "  ")).toEqual([]);
    expect(rankFiles([file({ path: "a.ts" })], "zzz")).toEqual([]);
  });
});

describe("rankSymbols", () => {
  it("ranks exact symbol names first and carries line/kind", () => {
    const files = [
      file({
        path: "src/a.ts",
        symbols: [
          { name: "handler", line: 10, kind: "function" },
          { name: "handle", line: 20, kind: "function" },
        ],
      }),
    ];
    const hits = rankSymbols(files, "handle");
    expect(hits[0].name).toBe("handle");
    expect(hits[0].line).toBe(20);
    expect(hits[0].kind).toBe("function");
  });
});

describe("matchOutline", () => {
  it("matches by suffix, basename, and substring", () => {
    const files = [file({ path: "src/deep/module.ts" })];
    expect(matchOutline(files, "module.ts")?.path).toBe("src/deep/module.ts");
    expect(matchOutline(files, "deep/module.ts")?.path).toBe("src/deep/module.ts");
    expect(matchOutline(files, "nope")).toBeNull();
  });
});
