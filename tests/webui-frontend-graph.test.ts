import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImportGraph, collectFiles, findCycles } from "./helpers/import-graph";

/**
 * Frontend (src/modules/webui/assets/**) ESM graph guard.
 *
 * Enforces acyclicity across `assets/**` and that there are no layer inversions
 * (a lower module importing a higher one). Phase 4 moved the menu helpers into a
 * leaf (`core/menus.js`), so the previously-known `settings.js -> tabs.js` edge
 * is gone — the list must stay empty.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ASSETS_DIR = resolve(REPO_ROOT, "src/modules/webui/assets");

/** Edges that are known-but-undesired; kept empty on purpose (no inversions). */
const KNOWN_INVERSIONS: string[] = [];

function formatCycles(cycles: string[][]): string {
  return cycles.map((c) => `  ${c.join(" -> ")} -> ${c[0]}`).join("\n");
}

describe("webui frontend import graph", () => {
  it("has no import cycles across entry points and js/ modules", () => {
    const files = collectFiles(ASSETS_DIR, REPO_ROOT, [".js"], { skipTests: true });
    const cycles = findCycles(buildImportGraph(files));
    expect(cycles, `Import cycles in src/modules/webui/assets:\n${formatCycles(cycles)}`).toEqual([]);
  });

  it("has no settings -> tabs layer inversion (menus live in a leaf)", () => {
    const files = collectFiles(ASSETS_DIR, REPO_ROOT, [".js"], { skipTests: true });
    const graph = buildImportGraph(files);
    const settingsImports = [...graph.entries()]
      .filter(([path]) => path.endsWith("/settings.js"))
      .flatMap(([, edges]) => edges.map((e) => e.target));
    const inversions = settingsImports
      .filter((target) => target.endsWith("/tabs.js"))
      .map((target) => `src/modules/webui/assets/js/settings.js -> ${target}`);
    expect(inversions).toEqual(KNOWN_INVERSIONS);
  });
});
