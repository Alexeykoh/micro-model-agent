import { describe, it, expect } from "vitest";
import { addressesFromToolResult } from "../../src/core/context/ledger-parse";

describe("addressesFromToolResult", () => {
  it("extracts path:line from grep output (the findings)", () => {
    const out = "src/a.ts:1800:NEEDLE_A_111 marker\nsrc/a.ts:1810:other";
    const got = addressesFromToolResult("grep", { pattern: "NEEDLE_A" }, out);
    expect(got).toContainEqual({ address: "src/a.ts:1800", note: "NEEDLE_A_111 marker" });
    expect(got.some((g) => g.address === "src/a.ts:1810")).toBe(true);
  });

  it("keeps a Windows path intact in grep findings", () => {
    const got = addressesFromToolResult("grep", { pattern: "NEEDLE" }, "C:\\proj\\a.ts:1800:NEEDLE");
    expect(got).toEqual([{ address: "C:\\proj\\a.ts:1800", note: "NEEDLE" }]);
  });

  it("derives the read range from args (offset/limit), not the localized header", () => {
    const got = addressesFromToolResult(
      "read_file",
      { path: "corpus/big.txt", offset: 1, limit: 300 },
      "── corpus/big.txt (.txt, 4000 lines, lines 1-300)",
    );
    expect(got).toEqual([{ address: "corpus/big.txt:1", note: "1-300" }]);
  });

  it("records only the path when read args carry no range", () => {
    const got = addressesFromToolResult("read_file", { path: "x.txt" }, "── x.txt");
    expect(got).toEqual([{ address: "x.txt", note: "" }]);
  });

  it("records url for web and download tools", () => {
    expect(addressesFromToolResult("web_fetch", { url: "https://x.example/p" }, "body")).toEqual([
      { address: "https://x.example/p", note: "" },
    ]);
    expect(
      addressesFromToolResult("download_file", { url: "https://x.example/a.bin" }, "ok"),
    ).toEqual([{ address: "https://x.example/a.bin", note: "" }]);
  });

  it("returns nothing for non-source tools", () => {
    expect(addressesFromToolResult("bash", { command: "ls" }, "out")).toEqual([]);
  });
});
