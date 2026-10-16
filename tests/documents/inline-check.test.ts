import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  importedSpecifiers,
  missingInlined,
  scanImportedDeps,
} from "../../scripts/inline-check.ts";

/**
 * Оплата долга `documents-inline-unverified` (правило 9): проверка, что
 * документная деп, реально импортируемая `src/**`, попала в упакованный
 * `dist/main.js`. `missingInlined` — чистая сердцевина этой проверки; без неё
 * молча неверно собранный бандл ушёл бы пользователю.
 */
describe("inline-check: документные деп вшиты в бандл", () => {
  const metaWith = (paths: string[]): unknown => ({
    inputs: Object.fromEntries(paths.map((p) => [p, { bytes: 1, imports: [] }])),
  });

  it("деп есть во входах метафайла → ничего не пропущено", () => {
    const meta = metaWith([
      "src/cli/main.ts",
      "node_modules/fast-xml-parser/src/fxp.js",
      "node_modules/other/index.js",
    ]);
    expect(missingInlined(meta, ["fast-xml-parser"])).toEqual([]);
  });

  it("деп импортируется, но отсутствует во входах → назван как пропущенный", () => {
    const meta = metaWith(["src/cli/main.ts", "node_modules/other/index.js"]);
    expect(missingInlined(meta, ["fast-xml-parser"])).toEqual(["fast-xml-parser"]);
  });

  it("деп, который src не импортирует, не требуется в бандле", () => {
    const meta = metaWith(["src/cli/main.ts", "node_modules/fast-xml-parser/src/fxp.js"]);
    // pdfjs-dist не импортируется кодом — его отсутствие не ошибка (не передан в srcImportedDeps).
    expect(missingInlined(meta, ["fast-xml-parser"])).toEqual([]);
  });

  it("несколько деп: называются только пропущенные, вложенные пути учитываются", () => {
    const meta = metaWith(["node_modules/fast-xml-parser/src/fxp.js"]);
    expect(missingInlined(meta, ["fast-xml-parser", "pdfjs-dist"])).toEqual(["pdfjs-dist"]);
    const nested = metaWith(["node_modules/pdfjs-dist/legacy/build/pdf.mjs"]);
    expect(missingInlined(nested, ["pdfjs-dist"])).toEqual([]);
  });

  it("неразборчивый метафайл (нет inputs) → всё пропущено, без падения", () => {
    expect(missingInlined({}, ["fast-xml-parser"])).toEqual(["fast-xml-parser"]);
    expect(missingInlined(null, ["fast-xml-parser"])).toEqual(["fast-xml-parser"]);
  });
});

describe("inline-check: скан импортов src", () => {
  it("ловит статические, динамические и bare-imports, игнорируя комментарии", () => {
    const specs = importedSpecifiers(
      [
        'import { XMLParser } from "fast-xml-parser";',
        'const m = await import("pdfjs-dist/legacy/build/pdf.mjs");',
        'import "side-effect-pkg";',
        'export { x } from "yaml";',
        '// import "commented-out"',
        '/* import "block-commented" */',
      ].join("\n"),
    );
    expect(specs).toEqual([
      "fast-xml-parser",
      "pdfjs-dist/legacy/build/pdf.mjs",
      "side-effect-pkg",
      "yaml",
    ]);
  });

  it("scanImportedDeps возвращает только реально импортируемые документные деп", () => {
    // src/ в репозитории на момент W2 импортирует fast-xml-parser (ooxml.ts) и не импортирует pdfjs-dist.
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const found = scanImportedDeps(srcRoot, ["fast-xml-parser", "pdfjs-dist"]);
    expect(found).toContain("fast-xml-parser");
    expect(found).not.toContain("pdfjs-dist");
  });
});
