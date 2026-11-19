import { describe, it, expect } from "vitest";
import { selectMapFiles, isNoiseFile } from "../../../src/modules/indexer/map-select";
import type { IndexedFile } from "../../../src/modules/indexer/walker";

function f(path: string, language = "typescript"): IndexedFile {
  return { path, language, exports: [], size: 1 };
}

describe("selectMapFiles", () => {
  it("ranks source code above tests and docs/config", () => {
    const files = [
      f("CHANGELOG.md", "markdown"),
      f("tests/agent.test.ts"),
      f("src/index.ts"),
      f("package.json", "json"),
      f("tests/ui/renderer.test.ts"),
      f("src/core/agent.ts"),
    ];
    const picked = selectMapFiles(files, 10).map((x) => x.path);
    expect(picked.indexOf("src/index.ts")).toBeLessThan(picked.indexOf("tests/agent.test.ts"));
    expect(picked.indexOf("src/core/agent.ts")).toBeLessThan(picked.indexOf("CHANGELOG.md"));
  });

  it("drops lockfile noise", () => {
    const files = [f("package-lock.json", "json"), f("bun.lockb", "json"), f("src/index.ts")];
    const picked = selectMapFiles(files, 10).map((x) => x.path);
    expect(picked).toEqual(["src/index.ts"]);
    expect(isNoiseFile(f("yarn.lock"))).toBe(true);
    expect(isNoiseFile(f("src/index.ts"))).toBe(false);
  });

  it("prefers shallower paths within the same rank", () => {
    const files = [f("src/core/agent/loop/state.ts"), f("src/index.ts"), f("src/agent.ts")];
    const picked = selectMapFiles(files, 10).map((x) => x.path);
    expect(picked).toEqual(["src/agent.ts", "src/index.ts", "src/core/agent/loop/state.ts"]);
  });

  it("puts the densest source directory first without hardcoded directory names", () => {
    const files = [
      f("scripts/tool.ts"),
      f("fixtures/one.ts"),
      f("src/a.ts"),
      f("src/b.ts"),
      f("src/c.ts"),
    ];
    const picked = selectMapFiles(files, 10).map((x) => x.path);
    expect(picked.slice(0, 3)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("is deterministic regardless of input order", () => {
    const a = [f("src/b.ts"), f("src/a.ts"), f("tests/x.test.ts")];
    const b = [f("tests/x.test.ts"), f("src/a.ts"), f("src/b.ts")];
    expect(selectMapFiles(a, 10).map((x) => x.path)).toEqual(
      selectMapFiles(b, 10).map((x) => x.path),
    );
  });

  it("respects the max cap", () => {
    const files = Array.from({ length: 200 }, (_, i) => f(`src/f${String(i).padStart(3, "0")}.ts`));
    expect(selectMapFiles(files, 80)).toHaveLength(80);
  });

  it("keeps a source file even when the walk order buries it behind docs", () => {
    const files = [f("README.md", "markdown"), f("docs/a.md", "markdown"), f("src/real.ts")];
    expect(selectMapFiles(files, 2).map((x) => x.path)).toEqual(["src/real.ts", "README.md"]);
  });
});
