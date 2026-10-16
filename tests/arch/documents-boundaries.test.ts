import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImportGraph, collectFiles, type ScanFile } from "../helpers/import-graph";

/**
 * Architecture gate (INV-D2, W1).
 *
 * Потребители документов зависят только от `DocumentIR`: формат-специфичные
 * обработчики (`src/modules/documents/handlers/*`) импортируются исключительно
 * из `registry.ts` (точка сборки реестра) и самим бочонком `handlers/index.ts`
 * (точка вкл/выкл, INV-D3). Любой другой импорт обработчиков — падение.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC_DIR = resolve(REPO_ROOT, "src");
const HANDLERS_PREFIX = "src/modules/documents/handlers/";
/** Файлы, которым разрешено импортировать `handlers/*`. */
const ALLOWED_IMPORTERS = new Set([
  "src/modules/documents/registry.ts",
  "src/modules/documents/handlers/index.ts",
]);

/** `from:line: specifier` для каждого импорта `handlers/*` вне allowlist. */
export function findDocumentHandlerImports(files: ScanFile[]): string[] {
  const graph = buildImportGraph(files);
  const offenders: string[] = [];
  for (const [from, edges] of graph) {
    if (ALLOWED_IMPORTERS.has(from)) continue;
    for (const e of edges) {
      if (e.target.startsWith(HANDLERS_PREFIX)) offenders.push(`${from}:${e.line}: ${e.specifier}`);
    }
  }
  return offenders;
}

describe("architecture: documents boundaries (INV-D2)", () => {
  it("handlers/* импортируется только из registry.ts и handlers/index.ts", () => {
    const files = collectFiles(SRC_DIR, REPO_ROOT, [".ts"], { skipTests: true });
    const offenders = findDocumentHandlerImports(files);
    expect(
      offenders,
      `Only registry.ts (and handlers/index.ts) may import document handlers (INV-D2):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("сканер ловит прямой импорт обработчика из потребителя", () => {
    const fixtures: ScanFile[] = [
      { path: "src/modules/documents/read.ts", text: 'import { csvHandler } from "./handlers/csv";\n' },
      { path: "src/modules/documents/handlers/csv.ts", text: "export const csvHandler = 1;\n" },
    ];
    expect(findDocumentHandlerImports(fixtures)).toEqual([
      'src/modules/documents/read.ts:1: ./handlers/csv',
    ]);
  });

  it("сканер разрешает импорт из registry.ts", () => {
    const fixtures: ScanFile[] = [
      { path: "src/modules/documents/registry.ts", text: 'import { csvHandler } from "./handlers/csv";\n' },
      { path: "src/modules/documents/handlers/csv.ts", text: "export const csvHandler = 1;\n" },
    ];
    expect(findDocumentHandlerImports(fixtures)).toEqual([]);
  });
});
