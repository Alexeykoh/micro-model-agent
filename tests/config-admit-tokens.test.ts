import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import { getConfigValue, setConfigValue } from "../src/config/registry";
import type { AppConfig } from "../src/config/types";

describe("contextBudget.admitMaxTokens", () => {
  it("defaults to 3000 tokens", () => {
    expect(DEFAULTS.contextBudget.admitMaxTokens).toBe(3000);
  });

  it("round-trips through the registry and rejects out-of-range", () => {
    const c = structuredClone(DEFAULTS) as AppConfig;
    expect(getConfigValue(c, "contextBudget.admitMaxTokens").value).toBe(3000);
    expect(setConfigValue(c, "contextBudget.admitMaxTokens", "2000").ok).toBe(true);
    expect(getConfigValue(c, "contextBudget.admitMaxTokens").value).toBe(2000);
    expect(setConfigValue(c, "contextBudget.admitMaxTokens", "999999").ok).toBe(false);
    expect(setConfigValue(c, "contextBudget.admitMaxTokens", "0").ok).toBe(false);
  });
});
