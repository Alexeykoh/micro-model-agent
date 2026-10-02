import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildImportGraph,
  collectFiles,
  findCycles,
  findIdentifierRefs,
  type ScanFile,
} from "./helpers/import-graph";

/**
 * Backend (src/modules/webui/**) structural guard.
 *
 * Enforces two invariants of the second-pass modularization:
 * 1. No import cycles (value edges; `import type` is erased at runtime).
 * 2. Domain modules consume the narrow role interfaces (`SseTransport`,
 *    `SessionStore`, …) and never the composed `WebUiState` god-object. Only the
 *    composition root and the transport entry points may see the whole state.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEBUI_DIR = resolve(REPO_ROOT, "src/modules/webui");

/**
 * Files allowed to reference the composed `WebUiState`: the state composition
 * itself, the orchestrator, and the transport entry points (`server`/`util`).
 */
const COMPOSITE_STATE_ALLOWED = new Set([
  "src/modules/webui/state.ts",
  "src/modules/webui/module.ts",
  "src/modules/webui/server.ts",
  "src/modules/webui/util.ts",
]);

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

  it("domain modules depend on role interfaces, not the composed WebUiState", () => {
    const files = collectFiles(WEBUI_DIR, REPO_ROOT, [".ts"], { skipTests: true });
    const offenders = findIdentifierRefs(files, "WebUiState")
      .filter((ref) => !COMPOSITE_STATE_ALLOWED.has(ref.path))
      .map((ref) => `  ${ref.path}:${ref.line}`);
    expect(
      offenders,
      `Domain modules must take a narrow role (SseTransport/SessionStore/ConfigStore/` +
        `RuntimeState/WorkspaceStore/HttpTransport), not the whole WebUiState:\n${offenders.join("\n")}`,
    ).toEqual([]);
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

  it("finds identifier refs in code but not in comments", () => {
    const fixtures: ScanFile[] = [
      { path: "x.ts", text: "// WebUiState in a comment\nconst y: WebUiState = 1 as never;\n" },
    ];
    const refs = findIdentifierRefs(fixtures, "WebUiState");
    expect(refs).toHaveLength(1);
    expect(refs[0].line).toBe(2);
  });
});
