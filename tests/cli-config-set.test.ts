import { describe, expect, it } from "vitest";
import { setConfigValue } from "../src/config/registry";
import { DEFAULTS } from "../src/config/defaults";
describe("terminal config validation", () => {
  it("rejects bad values and unknown keys", () => {
    const cfg = structuredClone(DEFAULTS);
    expect(setConfigValue(cfg, "contextWindow", "abc").ok).toBe(false);
    expect(setConfigValue(cfg, "nope.nope", "1").ok).toBe(false);
    expect(setConfigValue(cfg, "autoPlan", "off").ok).toBe(true);
  });
});
