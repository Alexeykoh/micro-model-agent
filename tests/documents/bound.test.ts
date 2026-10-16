import { describe, expect, it } from "vitest";
import { boundLine, boundTable, boundText, DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";

describe("bound", () => {
  it("обрезает текст по строкам с маркером", () => {
    const out = boundText("a\nb\nc\nd", { ...DEFAULT_DOC_LIMITS, maxLines: 2 });
    expect(out).toContain("[...truncated 2 lines...]");
    expect(out.split("\n")[0]).toBe("a");
  });
  it("обрезает таблицу и ставит truncated", () => {
    const t = boundTable({ header: ["h"], rows: [["1"], ["2"], ["3"]] }, { ...DEFAULT_DOC_LIMITS, maxTableRows: 1 });
    expect(t.rows).toHaveLength(1);
    expect(t.truncated).toBe(true);
  });
  it("длинную строку-заголовок обрезает по maxChars с маркером (INV-D4)", () => {
    const long = "x".repeat(DEFAULT_DOC_LIMITS.maxChars + 1_000);
    const out = boundLine(long, DEFAULT_DOC_LIMITS);
    expect(out.startsWith("x".repeat(DEFAULT_DOC_LIMITS.maxChars))).toBe(true);
    expect(out).toContain(`[...truncated to ${DEFAULT_DOC_LIMITS.maxChars} chars...]`);
    expect(out.length).toBeLessThan(long.length);
  });
  it("короткую строку не меняет", () => {
    expect(boundLine("short heading", DEFAULT_DOC_LIMITS)).toBe("short heading");
    expect(boundLine("x".repeat(DEFAULT_DOC_LIMITS.maxChars), DEFAULT_DOC_LIMITS)).toHaveLength(DEFAULT_DOC_LIMITS.maxChars);
  });
});
