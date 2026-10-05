import { describe, expect, it } from "bun:test";
import { DEFAULTS } from "../../src/config/defaults";
import {
  captureConfigSnapshot,
  getConfigValue,
  resolveConfigKey,
  setConfigValue,
  keysForGroup,
} from "../../src/config/registry";
import type { AppConfig } from "../../src/config/types";

function freshConfig(): AppConfig {
  return structuredClone(DEFAULTS);
}

describe("config registry", () => {
  it("resolves canonical keys and aliases to the same definition", () => {
    expect(resolveConfigKey("contextBudget.systemPrompt")?.key).toBe(
      "contextBudget.systemPrompt",
    );
    expect(resolveConfigKey("context.system")?.key).toBe("contextBudget.systemPrompt");
    expect(resolveConfigKey("context.window")?.key).toBe("contextWindow");
    expect(resolveConfigKey("nope")).toBeNull();
  });

  it("reads a value", () => {
    const cfg = freshConfig();
    const got = getConfigValue(cfg, "model");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.display).toBe(DEFAULTS.model);
  });

  it("sets a string key and reports reconfigure", () => {
    const cfg = freshConfig();
    const res = setConfigValue(cfg, "model", "some/model");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reconfigure).toBe(true);
      expect(cfg.model).toBe("some/model");
    }
  });

  it("sets via alias", () => {
    const cfg = freshConfig();
    const res = setConfigValue(cfg, "context.window", "64000");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.key).toBe("contextWindow");
    expect(cfg.contextWindow).toBe(64000);
  });

  it("accepts percentages for shares", () => {
    const cfg = freshConfig();
    const res = setConfigValue(cfg, "contextBudget.systemPrompt", "10%");
    expect(res.ok).toBe(true);
    expect(cfg.contextBudget.systemPrompt).toBeCloseTo(0.1);
  });

  it("rejects out-of-range shares", () => {
    const cfg = freshConfig();
    const res = setConfigValue(cfg, "contextBudget.systemPrompt", "0.99");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid-value");
  });

  it("enforces system + reserve <= 0.95", () => {
    const cfg = freshConfig();
    const res = setConfigValue(cfg, "contextBudget.systemPrompt", "0.9");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("combined");
  });

  it("parses booleans for showReasoning", () => {
    const cfg = freshConfig();
    expect(setConfigValue(cfg, "showReasoning", "off").ok).toBe(true);
    expect(cfg.showReasoning).toBe(false);
    expect(setConfigValue(cfg, "showReasoning", "on").ok).toBe(true);
    expect(cfg.showReasoning).toBe(true);
  });

  it("sets reasoning.mode enum", () => {
    const cfg = freshConfig();
    const res = setConfigValue(cfg, "reasoning.mode", "high");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.reasoningChanged).toBe(true);
    expect(cfg.reasoning?.mode).toBe("high");
  });

  it("rejects read-only keys", () => {
    const cfg = freshConfig();
    const res = setConfigValue(cfg, "version", "9.9.9");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("read-only");
  });

  it("rejects unknown keys", () => {
    const cfg = freshConfig();
    const res = setConfigValue(cfg, "does.not.exist", "1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown-key");
  });

  it("groups keys by canonical prefix", () => {
    const keys = keysForGroup("contextBudget").map((d) => d.key);
    expect(keys).toEqual(["contextBudget.systemPrompt", "contextBudget.responseReserve", "contextBudget.compactionThreshold", "contextBudget.compactionMinLoad", "contextBudget.policy", "contextBudget.overflowCooldown", "contextBudget.toolResultKeep", "contextBudget.calibrationWarmup", "contextBudget.ratioFloor"]);
  });

  it("captures a boot snapshot", () => {
    const cfg = freshConfig();
    const snap = captureConfigSnapshot(cfg);
    expect(snap.get("model")).toBe(DEFAULTS.model);
    expect(snap.get("contextWindow")).toBe(DEFAULTS.contextWindow);
  });

  it("remembers the last model per provider and restores it on switch", () => {
    const cfg = freshConfig();
    cfg.provider = {
      active: "a",
      entries: [
        { type: "openai-compat", label: "a", baseUrl: "http://a/v1" },
        { type: "openai-compat", label: "b", baseUrl: "http://b/v1" },
      ],
      type: "openai-compat",
      baseUrl: "http://a/v1",
    };

    expect(setConfigValue(cfg, "model", "model-a").ok).toBe(true);
    expect(cfg.provider.models).toEqual({ a: "model-a" });

    // `b` has no memory yet → the current model is kept.
    expect(setConfigValue(cfg, "provider.active", "b").ok).toBe(true);
    expect(cfg.model).toBe("model-a");

    expect(setConfigValue(cfg, "model", "model-b").ok).toBe(true);
    expect(cfg.provider.models).toEqual({ a: "model-a", b: "model-b" });

    // Switching back restores what `a` used last.
    expect(setConfigValue(cfg, "provider.active", "a").ok).toBe(true);
    expect(cfg.model).toBe("model-a");
  });

  it("mirrors legacy flat fields from the active entry on provider switch", () => {
    const cfg = freshConfig();
    cfg.provider = {
      active: "a",
      entries: [
        { type: "openai-compat", label: "a", baseUrl: "http://a/v1" },
        { type: "opencode-go", label: "b", baseUrl: "https://go/v1", apiKey: "k" },
      ],
      type: "openai-compat",
      baseUrl: "http://a/v1",
    };

    expect(setConfigValue(cfg, "provider.active", "b").ok).toBe(true);
    expect(cfg.provider.type).toBe("opencode-go");
    expect(cfg.provider.baseUrl).toBe("https://go/v1");
    expect(cfg.provider.apiKey).toBe("k");

    // Unknown name is rejected: active and flat fields stay untouched.
    const bad = setConfigValue(cfg, "provider.active", "nope");
    expect(bad.ok).toBe(false);
    expect(cfg.provider.active).toBe("b");
    expect(cfg.provider.baseUrl).toBe("https://go/v1");
  });
});
