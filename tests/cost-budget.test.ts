// Per-run бюджет (Cost/LLM-gateway MVP): helper `costBudgetExceeded`.
import { describe, it, expect } from "vitest";
import { costBudgetExceeded } from "../src/core/agent/cost-budget";

describe("costBudgetExceeded", () => {
  it("disabled at 0 (no limit)", () => {
    expect(costBudgetExceeded(10_000, 0)).toBe(false);
  });
  it("true at or above the cap", () => {
    expect(costBudgetExceeded(5, 5)).toBe(true);
    expect(costBudgetExceeded(6, 5)).toBe(true);
    expect(costBudgetExceeded(4.9, 5)).toBe(false);
  });
});
