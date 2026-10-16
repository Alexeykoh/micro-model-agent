import { describe, expect, it } from "vitest";
import { boundTable, boundText, DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";

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
});
