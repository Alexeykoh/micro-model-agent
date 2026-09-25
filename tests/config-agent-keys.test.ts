import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import { configDefs, getConfigValue, setConfigValue } from "../src/config/registry";
import type { AppConfig } from "../src/config/types";

function cfg(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
}

describe("registry: MoE + critic keys", () => {
  it("exposes defaults", () => {
    const c = cfg();
    expect(getConfigValue(c, "moe.enabled").value).toBe(false);
    expect(getConfigValue(c, "moe.maxReplanCycles").value).toBe(3);
    expect(getConfigValue(c, "critic.enabled").value).toBe(true);
    expect(getConfigValue(c, "critic.maxCalls").value).toBe(4);
    expect(getConfigValue(c, "critic.maxRepairCycles").value).toBe(1);
    expect(getConfigValue(c, "critic.timeoutMs").value).toBe(15000);
  });

  it("writes booleans and ints into the nested config", () => {
    const c = cfg();
    expect(setConfigValue(c, "moe.enabled", "true").ok).toBe(true);
    expect(c.moe.enabled).toBe(true);

    expect(setConfigValue(c, "critic.enabled", "false").ok).toBe(true);
    expect(c.critic.enabled).toBe(false);

    expect(setConfigValue(c, "critic.maxRepairCycles", "2").ok).toBe(true);
    expect(c.critic.maxRepairCycles).toBe(2);

    expect(setConfigValue(c, "critic.timeoutMs", "30000").ok).toBe(true);
    expect(c.critic.timeoutMs).toBe(30000);
  });

  it("rejects an out-of-range value", () => {
    const c = cfg();
    expect(setConfigValue(c, "critic.maxCalls", "999").ok).toBe(false);
  });

  it("marks the keys as requiring reconfigure", () => {
    const keys = ["moe.enabled", "moe.maxReplanCycles", "critic.enabled", "critic.maxCalls"];
    for (const key of keys) {
      const def = configDefs().find((d) => d.key === key);
      expect(def?.reconfigure).toBe(true);
    }
  });
});
