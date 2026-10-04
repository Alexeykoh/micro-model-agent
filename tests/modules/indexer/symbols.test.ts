import { describe, it, expect } from "vitest";
import { extractSymbolsDetailed } from "../../../src/modules/indexer/symbols";

describe("extractSymbolsDetailed", () => {
  it("captures name, line and kind for TS exports", () => {
    const src = [
      "// header",
      "export const a = 1;",
      "export function foo() {}",
      "export interface Bar {}",
      "export class Baz {}",
    ].join("\n");
    const syms = extractSymbolsDetailed(src, "typescript");
    expect(syms).toEqual([
      { name: "a", line: 2, kind: "const" },
      { name: "foo", line: 3, kind: "function" },
      { name: "Bar", line: 4, kind: "interface" },
      { name: "Baz", line: 5, kind: "class" },
    ]);
  });

  it("captures Python def/class with lines", () => {
    const src = "class A:\n    pass\n\ndef run():\n    pass\n";
    expect(extractSymbolsDetailed(src, "python")).toEqual([
      { name: "A", line: 1, kind: "class" },
      { name: "run", line: 4, kind: "function" },
    ]);
  });

  it("captures export clauses with kind export", () => {
    const src = "const x = 1;\nexport { x, y as z };\n";
    expect(extractSymbolsDetailed(src, "typescript")).toEqual([
      { name: "x", line: 2, kind: "export" },
      { name: "z", line: 2, kind: "export" },
    ]);
  });

  it("returns nothing for unknown or symbol-less languages", () => {
    expect(extractSymbolsDetailed("x", "unknownlang")).toEqual([]);
    expect(extractSymbolsDetailed("# hi", "markdown")).toEqual([]);
  });
});
