import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImportGraph, collectFiles, findCycles, type ScanFile } from "./helpers/import-graph";

/**
 * Backend (src/modules/webui/**) structural guard.
 *
 * Phase 0 only enforces acyclicity — the webui module has no legitimate import
 * cycle, and a second-pass modularization must not introduce one. Phase 2 will
 * extend this file with a narrow-interface rule (domains may not depend on the
 * composed `WebUiState`).
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEBUI_DIR = resolve(REPO_ROOT, "src/modules/webui");

function formatCycles(cycles: string[][]): string {
  return cycles.map((c) => `  ${c.join(" -> ")} -> ${c[0]}`).join("\n");
}

describe("webui backend import boundaries", () => {
  it("scans the module and resolves internal edges", () => {
    const files = collectFiles(WEBUI_DIR, REPO_ROOT, [".ts"], { skipTests: true });
    expect(files.length).toBeGreaterThan(30);
    const graph = buildImportGraph(files);
    const edges = [...graph.values()].reduce((n, e) => n + e.length, 0);
    expect(edges).toBeGreaterThan(30);
  });

  it("has no import cycles", () => {
    const files = collectFiles(WEBUI_DIR, REPO_ROOT, [".ts"], { skipTests: true });
    const cycles = findCycles(buildImportGraph(files));
    expect(cycles, `Import cycles in src/modules/webui:\n${formatCycles(cycles)}`).toEqual([]);
  });
});

describe("import-graph helper", () => {
  it("detects a simple cycle across fixtures", () => {
    const fixtures: ScanFile[] = [
      { path: "a.ts", text: 'import { b } from "./b";\nexport const a = b;\n' },
      { path: "b.ts", text: 'import { a } from "./a";\nexport const b = a;\n' },
    ];
    const cycles = findCycles(buildImportGraph(fixtures));
    expect(cycles).toHaveLength(1);
    expect(cycles[0].sort()).toEqual(["a.ts", "b.ts"]);
  });
});
