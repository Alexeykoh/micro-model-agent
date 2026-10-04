import { describe, it, expect } from "vitest";
import { mapWorkspaceSymbols, symbolKindName, uriToPath } from "../../../src/modules/lsp/symbols";
import { getServerForLanguage } from "../../../src/modules/lsp/config";
import { DEFAULT_LSP_CONFIG } from "../../../src/modules/lsp/config";

describe("symbolKindName", () => {
  it("maps LSP symbol kinds", () => {
    expect(symbolKindName(12)).toBe("function");
    expect(symbolKindName(5)).toBe("class");
    expect(symbolKindName(999)).toBe("symbol");
    expect(symbolKindName(undefined)).toBe("symbol");
  });
});

describe("uriToPath", () => {
  it("strips the scheme, decodes, and fixes Windows drive paths", () => {
    expect(uriToPath("file:///home/app/src/a.ts")).toBe("/home/app/src/a.ts");
    expect(uriToPath("file:///C:/dev/app/src/a.ts")).toBe("C:/dev/app/src/a.ts");
    expect(uriToPath("file:///C:/dev/a%20b.ts")).toBe("C:/dev/a b.ts");
  });
});

describe("mapWorkspaceSymbols", () => {
  it("maps SymbolInformation[] to relative locations", () => {
    const result = [
      {
        name: "IndexerModule",
        kind: 5,
        location: { uri: "file:///C:/repo/src/modules/indexer/module.ts", range: { start: { line: 25 } } },
      },
      { name: "ignored" },
    ];
    const mapped = mapWorkspaceSymbols(result, "C:/repo");
    expect(mapped).toEqual([
      { name: "IndexerModule", kind: "class", path: "src/modules/indexer/module.ts", line: 26 },
    ]);
  });

  it("returns empty for a non-array result", () => {
    expect(mapWorkspaceSymbols(null, "/repo")).toEqual([]);
    expect(mapWorkspaceSymbols({}, "/repo")).toEqual([]);
  });
});

describe("getServerForLanguage", () => {
  it("resolves aliases and unknown languages", () => {
    expect(getServerForLanguage("typescript-react", DEFAULT_LSP_CONFIG)?.command).toBe("npx");
    expect(getServerForLanguage("rust", DEFAULT_LSP_CONFIG)?.command).toBe("rust-analyzer");
    expect(getServerForLanguage("brainfuck", DEFAULT_LSP_CONFIG)).toBeNull();
  });
});
