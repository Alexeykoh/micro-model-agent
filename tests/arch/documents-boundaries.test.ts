import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImportGraph, collectFiles, type ScanFile } from "../helpers/import-graph";

/**
 * Architecture gate (INV-D2, W1; расширен в W2a).
 *
 * Потребители документов зависят только от `DocumentIR`: формат-специфичные
 * обработчики (`src/modules/documents/handlers/*`) импортируются извне лишь из
 * `registry.ts` (точка сборки реестра) и бочонка `handlers/index.ts` (точка
 * вкл/выкл, INV-D3).
 *
 * Внутри `handlers/` импорты разрешены: обработчики делят общий ZIP/OOXML-слой
 * (`zip.ts`/`ooxml.ts`, W2) — это один слой, а не выход обработчика за границу
 * модуля. Запрет остаётся для **потребителей** (`read.ts`, `tools/*`,
 * `module.ts`, …): они не имеют права тянуть конкретный обработчик.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC_DIR = resolve(REPO_ROOT, "src");
const HANDLERS_PREFIX = "src/modules/documents/handlers/";
/** Файлы вне `handlers/`, которым разрешено импортировать `handlers/*`. */
const ALLOWED_IMPORTERS = new Set(["src/modules/documents/registry.ts"]);

/**
 * `from:line: specifier` для каждого импорта `handlers/*` недопустимым импортёром.
 * Импортёр внутри `handlers/` (сам является обработчиком либо его общим слоем)
 * или `registry.ts` — разрешён.
 */
export function findDocumentHandlerImports(files: ScanFile[]): string[] {
  const graph = buildImportGraph(files);
  const offenders: string[] = [];
  for (const [from, edges] of graph) {
    if (from.startsWith(HANDLERS_PREFIX) || ALLOWED_IMPORTERS.has(from)) continue;
    for (const e of edges) {
      if (e.target.startsWith(HANDLERS_PREFIX)) offenders.push(`${from}:${e.line}: ${e.specifier}`);
    }
  }
  return offenders;
}

describe("architecture: documents boundaries (INV-D2)", () => {
  it("handlers/* импортируется извне только из registry.ts (внутри handlers/ — свободно)", () => {
    const files = collectFiles(SRC_DIR, REPO_ROOT, [".ts"], { skipTests: true });
    const offenders = findDocumentHandlerImports(files);
    expect(
      offenders,
      `Only registry.ts may import document handlers from outside handlers/ (INV-D2):\n` +
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

  it("сканер разрешает импорт между обработчиками (общий слой handlers/)", () => {
    const fixtures: ScanFile[] = [
      { path: "src/modules/documents/handlers/xlsx.ts", text: 'import { readOoxml } from "./ooxml";\n' },
      { path: "src/modules/documents/handlers/ooxml.ts", text: 'import { readZip } from "./zip";\n' },
      { path: "src/modules/documents/handlers/zip.ts", text: "export const readZip = 1;\n" },
    ];
    expect(findDocumentHandlerImports(fixtures)).toEqual([]);
  });

  it("сканер ловит импорт обработчика из потребителя-тула (вне handlers/)", () => {
    const fixtures: ScanFile[] = [
      { path: "src/modules/documents/tools/document-read.ts", text: 'import { xlsxHandler } from "../handlers/xlsx";\n' },
      { path: "src/modules/documents/handlers/xlsx.ts", text: "export const xlsxHandler = 1;\n" },
    ];
    expect(findDocumentHandlerImports(fixtures)).toEqual([
      "src/modules/documents/tools/document-read.ts:1: ../handlers/xlsx",
    ]);
  });
});

describe("architecture: documents dependency isolation (INV-D8)", () => {
  it("fast-xml-parser импортируется только из handlers/ooxml.ts", () => {
    const files = collectFiles(SRC_DIR, REPO_ROOT, [".ts"], { skipTests: true });
    const importers = files
      .filter((f) => /["']fast-xml-parser["']/.test(f.text))
      .map((f) => f.path);
    expect(
      importers,
      `INV-D8: fast-xml-parser импортируется только из handlers/ooxml.ts:\n${importers.join("\n")}`,
    ).toEqual(["src/modules/documents/handlers/ooxml.ts"]);
  });
});
