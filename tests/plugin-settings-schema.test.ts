// Манифест настроек плагина: валидация схемы, coerce, merge, секреты.
import { describe, expect, it } from "vitest";
import type { PluginSettingDef } from "../src/modules/types";
import {
  applyPatch,
  checkValue,
  coerceValue,
  mergeWithDefaults,
  redactSecrets,
  schemaDefaults,
  validateSettingsSchema,
} from "../src/modules/plugins/settings-schema";

const str: PluginSettingDef = { key: "greeting", type: "string", default: "hi" };
const num: PluginSettingDef = { key: "retries", type: "number", min: 1, max: 5, default: 3 };
const flag: PluginSettingDef = { key: "verbose", type: "boolean", default: false };
const mode: PluginSettingDef = { key: "mode", type: "enum", enum: ["fast", "slow"], default: "fast" };
const tags: PluginSettingDef = { key: "paths", type: "list", default: [] };
const blob: PluginSettingDef = { key: "extra", type: "json" };
const secret: PluginSettingDef = { key: "token", type: "string", secret: true };

describe("validateSettingsSchema", () => {
  it("accepts a full schema without warnings", () => {
    const { defs, warnings } = validateSettingsSchema([str, num, flag, mode, tags, blob, secret]);
    expect(warnings).toEqual([]);
    expect(defs.map((d) => d.key)).toEqual([
      "greeting",
      "retries",
      "verbose",
      "mode",
      "paths",
      "extra",
      "token",
    ]);
  });

  it("treats missing schema as empty", () => {
    expect(validateSettingsSchema(undefined)).toEqual({ defs: [], warnings: [] });
  });

  it("drops broken defs with warnings instead of failing registration", () => {
    const { defs, warnings } = validateSettingsSchema([
      str,
      { key: "Bad-Key!", type: "string" },
      { key: "greeting", type: "string" },
      { key: "nope", type: "weird" },
      { key: "empty-enum", type: "enum", enum: [] },
      { key: "bad-default", type: "number", default: "abc" },
      "junk",
    ]);
    expect(defs.map((d) => d.key)).toEqual(["greeting"]);
    expect(warnings.length).toBeGreaterThanOrEqual(5);
  });
});

describe("checkValue / coerceValue", () => {
  it("rejects out-of-range numbers and unknown enum values", () => {
    expect(checkValue(num, 9)).toMatch(/above max/);
    expect(checkValue(num, 0)).toMatch(/below min/);
    expect(checkValue(mode, "warp")).toMatch(/expected one of/);
    expect(checkValue(mode, "fast")).toBeNull();
  });

  it("coerces form-like raw values", () => {
    expect(coerceValue(num, "4")).toBe(4);
    expect(coerceValue(num, "abc")).toBe("abc");
    expect(checkValue(num, coerceValue(num, "abc"))).not.toBeNull();
    expect(coerceValue(flag, "true")).toBe(true);
    expect(coerceValue(flag, "false")).toBe(false);
    expect(coerceValue(tags, "a, b,, c")).toEqual(["a", "b", "c"]);
    expect(coerceValue(tags, ["x"])).toEqual(["x"]);
  });
});

describe("defaults and merge", () => {
  it("exposes non-secret defaults only", () => {
    expect(schemaDefaults([str, num, secret])).toEqual({ greeting: "hi", retries: 3 });
  });

  it("stored values win over defaults, unknown keys survive", () => {
    const merged = mergeWithDefaults([str, num], { greeting: "yo", future: 1 });
    expect(merged).toMatchObject({ greeting: "yo", retries: 3, future: 1 });
  });

  it("ignores stored values that violate the schema", () => {
    const merged = mergeWithDefaults([num], { retries: 99 });
    expect(merged).toEqual({ retries: 3 });
  });
});

describe("secrets and patch", () => {
  it("redacts secrets for the view", () => {
    const { values, hasSecrets } = redactSecrets([str, secret], { greeting: "hi", token: "s3cr3t" });
    expect(values).toMatchObject({ greeting: "hi", token: "" });
    expect(hasSecrets).toEqual(["token"]);
  });

  it("blank secret in patch keeps the stored value", () => {
    const out = applyPatch([secret], { token: "s3cr3t" }, { token: "" });
    expect(out).toEqual({ values: { token: "s3cr3t" } });
  });

  it("rejects unknown keys and invalid values", () => {
    expect(applyPatch([num], {}, { ghost: 1 })).toEqual({ error: "unknown-key: ghost" });
    const bad = applyPatch([num], {}, { retries: 99 });
    expect(bad).toMatchObject({ error: expect.stringContaining("invalid-value") });
  });

  it("writes a valid patch over stored values", () => {
    expect(applyPatch([str, num], { greeting: "hi" }, { retries: "2" })).toEqual({
      values: { greeting: "hi", retries: 2 },
    });
  });
});
