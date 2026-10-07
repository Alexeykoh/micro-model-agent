import { describe, expect, it } from "vitest";
import {
  getConfigValue,
  parseConfigValue,
  resolveConfigKey,
  setConfigValue,
} from "../../src/config/registry";
import { DEFAULTS } from "../../src/config/defaults";
import { getFlatDicts } from "../../src/i18n";

function freshCfg() {
  return structuredClone(DEFAULTS);
}

describe("images.* config keys", () => {
  it("has defaults 30 / 104857600", () => {
    expect(DEFAULTS.images?.maxCount).toBe(30);
    expect(DEFAULTS.images?.maxBytes).toBe(104_857_600);
  });

  it("resolves both keys in the registry", () => {
    expect(resolveConfigKey("images.maxCount")).not.toBeNull();
    expect(resolveConfigKey("images.maxBytes")).not.toBeNull();
  });

  it("reads defaults", () => {
    const a = getConfigValue(freshCfg(), "images.maxCount");
    const b = getConfigValue(freshCfg(), "images.maxBytes");
    expect(a.ok && a.value).toBe(30);
    expect(b.ok && b.value).toBe(104_857_600);
  });

  it("writes int values", () => {
    const cfg = freshCfg();
    expect(setConfigValue(cfg, "images.maxCount", "50").ok).toBe(true);
    expect(cfg.images?.maxCount).toBe(50);
    expect(setConfigValue(cfg, "images.maxBytes", "1048576").ok).toBe(true);
    expect(cfg.images?.maxBytes).toBe(1_048_576);
  });

  it("rejects out-of-range values", () => {
    const cfg = freshCfg();
    expect(setConfigValue(cfg, "images.maxCount", "0").ok).toBe(false);
    expect(setConfigValue(cfg, "images.maxCount", "99999").ok).toBe(false);
    expect(setConfigValue(cfg, "images.maxBytes", "1").ok).toBe(false);
    expect(setConfigValue(cfg, "images.maxCount", "abc").ok).toBe(false);
  });

  it("parses ints via parseConfigValue", () => {
    const def = resolveConfigKey("images.maxCount");
    expect(def).not.toBeNull();
    if (!def) return;
    expect(parseConfigValue(def, "42")).toEqual({ ok: true, value: 42 });
    expect(parseConfigValue(def, "abc").ok).toBe(false);
  });

  it("has en + ru labels for key and description", () => {
    const dicts = getFlatDicts();
    for (const key of [
      "config.key.images.maxCount",
      "config.desc.images.maxCount",
      "config.key.images.maxBytes",
      "config.desc.images.maxBytes",
    ]) {
      expect(dicts.en[key], `en ${key}`).toBeTruthy();
      expect(dicts.ru[key], `ru ${key}`).toBeTruthy();
    }
  });
});
