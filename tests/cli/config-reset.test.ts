import { describe, it, expect } from "vitest";
import { rawFromValue } from "../../src/cli/config-mutations";
import { setConfigValue } from "../../src/config/registry";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";

/**
 * `/config reset` для json/list-ключей (аудит §7.6, план
 * `2026-10-12-harness-module-audit-fixes`, W7/Task 7.3): значение списка
 * может содержать запятые (regex `a{1,3}`), и разбиение по запятой портило
 * его; json-объект превращался в "[object Object]".
 */

describe("/config reset: json и list", () => {
  it("a list value with a comma survives the round trip", () => {
    const config = structuredClone(DEFAULTS) as AppConfig;
    const value = ["a{1,3}", "b"];
    const raw = rawFromValue(value, "list");
    expect(raw).toBe('["a{1,3}","b"]');

    const result = setConfigValue(config, "security.bash.blacklist", raw);
    expect(result.ok).toBe(true);
    expect(config.security?.bash?.blacklist).toEqual(value);
  });

  it("a json value round-trips as an object, not [object Object]", () => {
    const config = structuredClone(DEFAULTS) as AppConfig;
    const value = { "gpt-x": { contextWindow: 32000 } };
    const raw = rawFromValue(value, "json");
    expect(raw).toBe(JSON.stringify(value));

    const result = setConfigValue(config, "modelCapabilities", raw);
    expect(result.ok).toBe(true);
    expect(config.modelCapabilities).toEqual(value);
  });

  it("booleans keep their on/off form", () => {
    expect(rawFromValue(true, "bool")).toBe("on");
    expect(rawFromValue(false, "bool")).toBe("off");
  });

  it("plain values keep the string form", () => {
    expect(rawFromValue("qwen/qwen3.5-9b", "string")).toBe("qwen/qwen3.5-9b");
    expect(rawFromValue(42, "int")).toBe("42");
  });
});
