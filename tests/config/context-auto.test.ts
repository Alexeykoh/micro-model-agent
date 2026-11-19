// `contextAuto` — режим «окно берётся у провайдера» (см. types.ts / registry-extra).
import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../../src/config/defaults";
import { resolveConfigKey, setConfigValue, getConfigValue } from "../../src/config/registry";
import { domainForKey, extractDomain } from "../../src/config/domains";
import type { AppConfig } from "../../src/config/types";

function freshConfig(): AppConfig {
  return structuredClone(DEFAULTS);
}

describe("contextAuto config key", () => {
  it("reads as auto for legacy configs without the field", () => {
    const c = freshConfig();
    delete c.contextAuto;
    expect(getConfigValue(c, "contextAuto").value).toBe(true);
  });

  it("defaults to auto", () => {
    expect(freshConfig().contextAuto).toBe(true);
    expect(getConfigValue(freshConfig(), "contextAuto").value).toBe(true);
  });

  it("is a rebuilding bool in the budget domain", () => {
    const def = resolveConfigKey("contextAuto");
    expect(def?.key).toBe("contextAuto");
    expect(def?.valueType).toBe("bool");
    expect(def?.domain).toBe("budget");
    expect(def?.effects.length).toBeGreaterThan(0);
  });

  it("pinning a concrete window turns auto off", () => {
    const c = freshConfig();
    const res = setConfigValue(c, "contextWindow", "65536");
    expect(res.ok).toBe(true);
    expect(c.contextWindow).toBe(65536);
    expect(c.contextAuto).toBe(false);
    expect(getConfigValue(c, "contextAuto").value).toBe(false);
  });

  it("auto flips back on through the same write path", () => {
    const c = freshConfig();
    setConfigValue(c, "contextWindow", "8192");
    const on = setConfigValue(c, "contextAuto", "true");
    expect(on.ok).toBe(true);
    expect(c.contextAuto).toBe(true);
    const off = setConfigValue(c, "contextAuto", "false");
    expect(off.ok).toBe(true);
    expect(c.contextAuto).toBe(false);
  });

  it("persists with the core config domain", () => {
    expect(domainForKey("contextAuto")).toBe("core");
    const c = freshConfig();
    c.contextAuto = false;
    expect(extractDomain(c, "core")).toHaveProperty("contextAuto", false);
  });
});
