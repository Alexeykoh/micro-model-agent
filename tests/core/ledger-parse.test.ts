import { describe, it, expect } from "vitest";
import { addressesFromToolResult } from "../../src/core/context/ledger-parse";

describe("addressesFromToolResult", () => {
  it("extracts path:line from grep output (the findings)", () => {
    const out = "src/a.ts:1800:NEEDLE_A_111 marker\nsrc/a.ts:1810:other";
    const got = addressesFromToolResult("grep", { pattern: "NEEDLE_A" }, out);
    expect(got).toContainEqual({ address: "src/a.ts:1800", note: "NEEDLE_A_111 marker" });
    expect(got.some((g) => g.address === "src/a.ts:1810")).toBe(true);
  });

  it("records the path for read_file with its range", () => {
    const got = addressesFromToolResult("read_file", { path: "corpus/big.txt" }, "── corpus/big.txt (.txt, 4000 lines, lines 1-300)");
    expect(got[0].address).toContain("corpus/big.txt");
  });

  it("records url for web tools", () => {
    const got = addressesFromToolResult("web_fetch", { url: "https://x.example/p" }, "body");
    expect(got[0].address).toBe("https://x.example/p");
  });

  it("returns nothing for non-source tools", () => {
    expect(addressesFromToolResult("bash", { command: "ls" }, "out")).toEqual([]);
  });
});
