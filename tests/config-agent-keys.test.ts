import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import { configDefs, getConfigValue, setConfigValue } from "../src/config/registry";
import type { AppConfig } from "../src/config/types";

function cfg(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
}

describe("registry: critic keys", () => {
  it("exposes defaults", () => {
    const c = cfg();
    expect(getConfigValue(c, "critic.enabled").value).toBe(true);
    expect(getConfigValue(c, "critic.maxCalls").value).toBe(4);
    expect(getConfigValue(c, "critic.maxRepairCycles").value).toBe(1);
    expect(getConfigValue(c, "critic.timeoutMs").value).toBe(60000);
    expect(getConfigValue(c, "critic.maxTokens").value).toBe(2048);
  });

  it("writes booleans and ints into the nested config", () => {
    const c = cfg();
    expect(setConfigValue(c, "critic.enabled", "false").ok).toBe(true);
    expect(c.critic.enabled).toBe(false);

    expect(setConfigValue(c, "critic.maxRepairCycles", "2").ok).toBe(true);
    expect(c.critic.maxRepairCycles).toBe(2);

    expect(setConfigValue(c, "critic.timeoutMs", "30000").ok).toBe(true);
    expect(c.critic.timeoutMs).toBe(30000);

    expect(setConfigValue(c, "critic.maxTokens", "4096").ok).toBe(true);
    expect(c.critic.maxTokens).toBe(4096);
  });

  it("rejects an out-of-range value", () => {
    const c = cfg();
    expect(setConfigValue(c, "critic.maxCalls", "999").ok).toBe(false);
  });

  it("marks the keys as requiring a rebuild", () => {
    for (const key of ["critic.enabled", "critic.maxCalls"]) {
      const def = configDefs().find((d) => d.key === key);
      expect(def?.effects.length).toBeGreaterThan(0);
    }
  });
});

describe("MoE keys are gone", () => {
  // MoE was a second execution harness that replaced the single-loop path and
  // bypassed every gate; it is removed (docs/specs/2026-10-12-remove-moe-design.md).
  // A stale key from an old config must read as unknown, never silently resolve.
  const removed = [
    "moe.enabled",
    "moe.maxReplanCycles",
    "moe.parallelSubtasks",
    "orchestrator.model",
    "orchestrator.provider",
    "orchestrator.contextWindow",
  ];

  it("no longer resolves in getConfigValue", () => {
    const c = cfg();
    for (const key of removed) {
      expect(getConfigValue(c, key).ok).toBe(false);
    }
  });

  it("no longer accepts a write", () => {
    const c = cfg();
    for (const key of removed) {
      expect(setConfigValue(c, key, "true").ok).toBe(false);
    }
  });

  it("is absent from the config definitions", () => {
    const keys = configDefs().map((d) => d.key);
    for (const key of removed) {
      expect(keys).not.toContain(key);
    }
  });
});

describe("registry: provider references", () => {
  it("critic.model accepts empty (use active model)", () => {
    const c = cfg();
    expect(setConfigValue(c, "critic.model", "judge").ok).toBe(true);
    expect(c.critic.model).toBe("judge");
    expect(setConfigValue(c, "critic.model", "").ok).toBe(true);
    expect(c.critic.model).toBeUndefined();
  });

  it("critic.provider accepts a provider name reference", () => {
    const c = cfg();
    c.provider.entries = [{ type: "openai-compat", label: "judge", baseUrl: "http://j/v1" }];
    expect(setConfigValue(c, "critic.provider", "judge").ok).toBe(true);
    expect(c.critic.provider).toBe("judge");
    expect(getConfigValue(c, "critic.provider").value).toBe("judge");
  });

  it("keeps the experts roster (subagent expert_tag still uses it)", () => {
    const c = cfg();
    expect(getConfigValue(c, "experts").ok).toBe(true);
  });
});