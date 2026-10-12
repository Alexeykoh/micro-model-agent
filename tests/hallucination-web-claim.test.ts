import { describe, it, expect } from "vitest";
import { extractAmountClaims, checkWebClaims } from "../src/core/hallucination/web-claims";
import { buildEvidencePack } from "../src/modules/critic/evidence";

describe("extractAmountClaims", () => {
  it("extracts grouped amounts and currency-marked numbers", () => {
    expect(extractAmountClaims("от 25 000 до 140 000 руб.")).toEqual(["25000", "140000"]);
    expect(extractAmountClaims("цена 15000 BYN")).toContain("15000");
  });

  it("ignores years and ids without a currency marker", () => {
    expect(extractAmountClaims("в 2026 году отчёт 1234")).toEqual([]);
  });
});

describe("checkWebClaims", () => {
  it("flags amounts absent from fetched pages", () => {
    const res = checkWebClaims("Rockhopper от 25 000 руб.", [
      { name: "web_fetch", ok: true, text: "page without numbers" },
    ]);
    expect(res?.tool).toBe("web-grounding");
    expect(res?.snippet).toContain("25000");
  });

  it("passes when the amount appears on a fetched page", () => {
    expect(
      checkWebClaims("Rockhopper от 25 000 руб.", [
        { name: "web_fetch", ok: true, text: "цена 25000 рублей" },
      ]),
    ).toBeNull();
  });

  it("ignores turns with no web tools", () => {
    expect(checkWebClaims("25 000 руб", [{ name: "bash", ok: true, text: "x" }])).toBeNull();
  });
});

describe("critic evidence web grounding (claim-aware)", () => {
  it("lists unverified claims absent from a fetched page", () => {
    const pack = buildEvidencePack({
      task: "bike prices",
      answerText: "Rockhopper от 25 000 руб.",
      toolEvents: [
        { tool: "web_fetch", args: { url: "x" }, ok: true, output: "R".repeat(400) },
      ],
    });
    expect(pack.webGrounding?.verified).toBe(false);
    expect(pack.webGrounding?.unverifiedClaims).toContain("25000");
  });

  it("stays verified when the claim is present in the fetched text", () => {
    const pack = buildEvidencePack({
      task: "bike prices",
      answerText: "Rockhopper от 25 000 руб.",
      toolEvents: [
        { tool: "web_fetch", args: { url: "x" }, ok: true, output: `цена 25000 руб ${"x".repeat(400)}` },
      ],
    });
    expect(pack.webGrounding?.verified).toBe(true);
    expect(pack.webGrounding?.unverifiedClaims).toBeUndefined();
  });
});
