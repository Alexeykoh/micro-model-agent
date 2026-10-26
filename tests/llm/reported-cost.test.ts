import { describe, expect, it } from "vitest";
import { parseReportedCost } from "../../src/llm/reported-cost";

describe("parseReportedCost", () => {
  it("reads opencode.list_cost", () => {
    expect(parseReportedCost({ opencode: { list_cost: 0.00001414 } })).toBeCloseTo(0.00001414, 12);
  });

  it("reads usage.cost fallback", () => {
    expect(parseReportedCost({ usage: { cost: 0.5 } })).toBe(0.5);
  });

  it("ignores missing or invalid cost", () => {
    expect(parseReportedCost({})).toBeUndefined();
    expect(parseReportedCost({ opencode: { list_cost: -1 } })).toBeUndefined();
    expect(parseReportedCost({ opencode: { list_cost: "x" } })).toBeUndefined();
    expect(parseReportedCost(null)).toBeUndefined();
  });
});
