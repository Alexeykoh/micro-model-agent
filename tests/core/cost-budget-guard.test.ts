import { describe, it, expect } from "bun:test";
import { costBudgetExceeded } from "../../src/core/agent/cost-budget";
import { DEFAULTS } from "../../src/config/defaults";

describe("default cost cap (L7)", () => {
  it("ships with a positive per-run cap instead of unlimited", () => {
    expect(DEFAULTS.cost!.maxRunUsd).toBeGreaterThan(0);
  });

  it("never trips on free/unpriced models (usage stays 0)", () => {
    expect(costBudgetExceeded(0, DEFAULTS.cost!.maxRunUsd!)).toBe(false);
  });

  it("stops a runaway run at the cap", () => {
    expect(costBudgetExceeded(5, 5)).toBe(true);
    expect(costBudgetExceeded(4.99, 5)).toBe(false);
  });

  it("keeps explicit 0 as the unlimited opt-out", () => {
    expect(costBudgetExceeded(999999, 0)).toBe(false);
  });
});
