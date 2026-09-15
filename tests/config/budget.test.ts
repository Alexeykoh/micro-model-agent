import { describe, it, expect } from "vitest";
import { budgetBreakdown, setBudgetShare, budgetBreakdownLines } from "../../src/config/budget";
import type { AppConfig } from "../../src/config/types";

function cfg(contextWindow = 32768, systemPrompt = 0.1, responseReserve = 0.15): AppConfig {
  return {
    contextWindow,
    contextBudget: { systemPrompt, responseReserve, compactionThreshold: 0.75 },
  } as unknown as AppConfig;
}

describe("budgetBreakdown", () => {
  it("splits the window into system / reserve / history", () => {
    const bd = budgetBreakdown(cfg());
    expect(bd.system).toBe(Math.floor(32768 * 0.1));
    expect(bd.reserve).toBe(Math.floor(32768 * 0.15));
    expect(bd.history).toBe(32768 - bd.system - bd.reserve);
    expect(bd.systemFraction).toBe(0.1);
  });
});

describe("setBudgetShare", () => {
  it("accepts a valid share and applies it", () => {
    const config = cfg();
    expect(setBudgetShare(config, "system", 0.2)).toBeNull();
    expect(config.contextBudget.systemPrompt).toBe(0.2);
  });

  it("rejects out-of-range values", () => {
    expect(setBudgetShare(cfg(), "system", 0.01)).toBe("range");
    expect(setBudgetShare(cfg(), "reserve", 0.95)).toBe("range");
    expect(setBudgetShare(cfg(), "system", Number.NaN)).toBe("range");
  });

  it("rejects a share that leaves no room for history", () => {
    expect(setBudgetShare(cfg(32768, 0.5, 0.5), "system", 0.9)).toBe("combined");
  });
});

describe("budgetBreakdownLines", () => {
  it("returns a header plus three localized lines", () => {
    const lines = budgetBreakdownLines(cfg());
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("32768");
  });
});
