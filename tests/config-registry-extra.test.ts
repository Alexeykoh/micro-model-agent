import { describe, expect, it } from "vitest";
import { parseConfigValue, formatConfigValue, type ConfigKeyDef } from "../src/config/registry";
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
});
