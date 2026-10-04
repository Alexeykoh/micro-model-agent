import { describe, it, expect } from "vitest";
import { buildFileGraph, pageRank } from "../../../src/modules/indexer/graph";
import { selectByRank } from "../../../src/modules/indexer/rank";
import type { IndexedFile } from "../../../src/modules/indexer/walker";

function file(path: string, imports: string[] = [], exports: string[] = []): IndexedFile {
  return {
    path,
    language: "typescript",
    exports,
    symbols: exports.map((name, i) => ({ name, line: i + 1, kind: "const" })),
    imports,
    size: 1,
    mtimeMs: 1,
  };
}

describe("buildFileGraph", () => {
  it("adds an edge from importer to imported file", () => {
    const files = [file("src/a.ts", ["./b"]), file("src/b.ts")];
    const { edges } = buildFileGraph(files);
    expect([...edges.get("src/a.ts")!]).toEqual(["src/b.ts"]);
    expect([...edges.get("src/b.ts")!]).toEqual([]);
  });

  it("resolves index files and path aliases", () => {
    const files = [
      file("src/app.ts", ["@/core/util", "../lib"]),
      file("src/core/util.ts"),
      file("lib.ts"),
    ];
    const { edges } = buildFileGraph(files);
    const targets = [...edges.get("src/app.ts")!].sort();
    expect(targets).toEqual(["lib.ts", "src/core/util.ts"]);
  });

  it("ignores external packages and non-code imports", () => {
    const files = [file("src/a.ts", ["react", "bun:test", "./styles.css"])];
    const { edges } = buildFileGraph(files);
    expect([...edges.get("src/a.ts")!]).toEqual([]);
  });

  it("ranks a widely-imported module above a leaf", () => {
    const files = [
      file("src/app.ts", ["./core"]),
      file("src/feature.ts", ["./core"]),
      file("src/core.ts"),
    ];
    const { ranks } = buildFileGraph(files);
    expect(ranks.get("src/core.ts")!).toBeGreaterThan(ranks.get("src/app.ts")!);
    expect(ranks.get("src/core.ts")!).toBeGreaterThan(ranks.get("src/feature.ts")!);
  });
});

describe("pageRank", () => {
  it("sums to ~1 and handles dangling nodes", () => {
    const ranks = pageRank(["a", "b", "c"], new Map([["a", new Set(["b"])]]));
    const total = [...ranks.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});

describe("selectByRank", () => {
  it("orders by importance and honors the token budget", () => {
    const files = [
      file("src/core.ts", [], ["core"]),
      file("src/app.ts"),
      file("src/feature.ts"),
    ];
    const ranks = new Map([
      ["src/core.ts", 0.7],
      ["src/app.ts", 0.2],
      ["src/feature.ts", 0.1],
    ]);
    const all = selectByRank(files, ranks, 10000, () => 1);
    expect(all[0].path).toBe("src/core.ts");

    // Budget for exactly one line → only the top-ranked file survives.
    const one = selectByRank(files, ranks, 1, () => 1);
    expect(one.map((f) => f.path)).toEqual(["src/core.ts"]);
  });
});
