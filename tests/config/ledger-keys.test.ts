import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../../src/config/defaults";
import { getConfigValue, setConfigValue } from "../../src/config/registry";
import type { AppConfig } from "../../src/config/types";

describe("context ledger config", () => {
  it("has defaults", () => {
    expect(DEFAULTS.contextBudget.notesPath).toBe(".mma/NOTES.md");
    expect(DEFAULTS.contextBudget.ledgerMax).toBe(200);
  });
  it("round-trips through the registry", () => {
    const c = structuredClone(DEFAULTS) as AppConfig;
    expect(getConfigValue(c, "contextBudget.notesPath").value).toBe(".mma/NOTES.md");
    expect(setConfigValue(c, "contextBudget.notesPath", "docs/notes.md").ok).toBe(true);
    expect(getConfigValue(c, "contextBudget.notesPath").value).toBe("docs/notes.md");
    expect(setConfigValue(c, "contextBudget.ledgerMax", "50").ok).toBe(true);
    expect(setConfigValue(c, "contextBudget.ledgerMax", "0").ok).toBe(false);
  });
});
