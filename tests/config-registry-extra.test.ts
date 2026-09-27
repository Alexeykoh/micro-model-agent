import { describe, expect, it } from "vitest";
import {
  parseConfigValue,
  formatConfigValue,
  resolveConfigKey,
  setConfigValue,
  type ConfigKeyDef,
} from "../src/config/registry";
import { DEFAULTS } from "../src/config/defaults";
const listDef = { valueType: "list" } as ConfigKeyDef;
const jsonDef = { valueType: "json" } as ConfigKeyDef;
describe("registry list/json types", () => {
  it("parses comma list, trims empties", () => {
    expect(parseConfigValue(listDef, "rm, dd, curl")).toEqual({ ok: true, value: ["rm", "dd", "curl"] });
    expect(parseConfigValue(listDef, "")).toEqual({ ok: true, value: [] });
  });
  it("parses JSON object, rejects broken + oversize", () => {
    expect(parseConfigValue(jsonDef, '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseConfigValue(jsonDef, "{oops")).toEqual({ ok: false, reason: "invalid" });
    expect(parseConfigValue(jsonDef, "x".repeat(20001))).toEqual({ ok: false, reason: "invalid" });
  });
  it("formats arrays and objects", () => {
    expect(formatConfigValue(["a", "b"])).toBe("a, b");
    expect(formatConfigValue({ a: 1 })).toBe('{"a":1}');
    expect(formatConfigValue(true)).toBe("on");
  });
  it("resolves new scalar keys", () => {
    expect(resolveConfigKey("autoPlan")).not.toBeNull();
    expect(resolveConfigKey("contextLog.enabled")).not.toBeNull();
    expect(resolveConfigKey("reasoning.min")).not.toBeNull();
    expect(resolveConfigKey("browser.headless")).not.toBeNull();
    expect(resolveConfigKey("security.rateLimits.maxRequestsPerMinute")).not.toBeNull();
  });
  it("round-trips autoPlan + rejects bad reasoning enum", () => {
    const cfg = structuredClone(DEFAULTS);
    const r = setConfigValue(cfg, "autoPlan", "off");
    expect(r.ok).toBe(true);
    expect(cfg.autoPlan).toBe(false);
    const bad = setConfigValue(cfg, "reasoning.min", "banana");
    expect(bad.ok).toBe(false);
  });
});
