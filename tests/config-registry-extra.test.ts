import { describe, expect, it } from "vitest";
import {
  configDefs,
  formatConfigValue,
  getConfigValue,
  parseConfigValue,
  resolveConfigKey,
  setConfigValue,
  type ConfigKeyDef,
} from "../src/config/registry";
import { DEFAULTS } from "../src/config/defaults";
import { readMmaVersion } from "../src/core/version";
import { getFlatDicts } from "../src/i18n";

const listDef = { valueType: "list" } as ConfigKeyDef;
const jsonDef = { valueType: "json" } as ConfigKeyDef;

function freshCfg() {
  return structuredClone(DEFAULTS);
}

/** Canonical key -> editor kind (fails the test when the key is unknown). */
function editorKind(key: string): string | undefined {
  const def = resolveConfigKey(key);
  expect(def, key).not.toBeNull();
  return def?.editor?.kind;
}

describe("registry value types", () => {
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

  it("accepts a JSON array for list keys (values may contain commas)", () => {
    const def = resolveConfigKey("security.bash.blacklist");
    expect(def).not.toBeNull();
    if (!def) return;
    expect(parseConfigValue(def, "a, b").ok).toBe(true);
    const r = parseConfigValue(def, '["a{1,3}","b"]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["a{1,3}", "b"]);
  });
});

describe("registry keys", () => {
  it("resolves new scalar keys", () => {
    for (const key of [
      "autoPlan",
      "contextLog.enabled",
      "reasoning.min",
      "browser.headless",
      "security.rateLimits.maxRequestsPerMinute",
      "security.bash.enabled",
      "security.network.enabled",
      "security.bash.blockDangerousFlags",
    ]) {
      expect(resolveConfigKey(key), key).not.toBeNull();
    }
  });

  it("round-trips a bool and rejects a bad enum", () => {
    const cfg = freshCfg();
    expect(setConfigValue(cfg, "autoPlan", "off").ok).toBe(true);
    expect(cfg.autoPlan).toBe(false);
    expect(setConfigValue(cfg, "reasoning.min", "banana").ok).toBe(false);
    expect(setConfigValue(cfg, "security.bash.enabled", "off").ok).toBe(true);
  });

  it("round-trips a list key", () => {
    const cfg = freshCfg();
    expect(setConfigValue(cfg, "security.bash.blacklist", "rm, dd").ok).toBe(true);
    expect(cfg.security?.bash.blacklist).toEqual(["rm", "dd"]);
    const got = getConfigValue(cfg, "security.bash.blacklist");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.display).toBe("rm, dd");
  });

  it("defaults ui.fontSize to comfortable and round-trips it", () => {
    const cfg = freshCfg();
    expect(cfg.ui.fontSize).toBe("comfortable");
    const got = getConfigValue(cfg, "ui.fontSize");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBe("comfortable");
    expect(setConfigValue(cfg, "ui.fontSize", "large").ok).toBe(true);
    expect(cfg.ui.fontSize).toBe("large");
    expect(setConfigValue(cfg, "ui.fontSize", "banana").ok).toBe(false);
    expect(cfg.ui.fontSize).toBe("large");
  });

  it("validates regex, record and enum shapes", () => {
    const cfg = freshCfg();
    expect(setConfigValue(cfg, "security.contentScan.dangerousPatterns", '["eval\\\\("]').ok).toBe(true);
    expect(setConfigValue(cfg, "security.contentScan.dangerousPatterns", '["(["]').ok).toBe(false);
    expect(setConfigValue(cfg, "pricing.overrides", '{"m":{"input":1,"output":2}}').ok).toBe(true);
    expect(setConfigValue(cfg, "pricing.overrides", '{"m":{"input":"x"}}').ok).toBe(false);
    expect(setConfigValue(cfg, "security.auditNotifier.minSeverity", "critical").ok).toBe(true);
    expect(setConfigValue(cfg, "security.auditNotifier.minSeverity", "banana").ok).toBe(false);
  });
  it("falls back to 8192 for maxCompletionTokens, min stays 512", () => {
    const cfg = freshCfg();
    delete (cfg.provider as Record<string, unknown>).maxCompletionTokens;
    const got = getConfigValue(cfg, "provider.maxCompletionTokens");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBe(8192);
    expect(setConfigValue(cfg, "provider.maxCompletionTokens", "100").ok).toBe(false);
    expect(setConfigValue(cfg, "provider.maxCompletionTokens", "8192").ok).toBe(true);
  });

  it("reports the installed package version for `version`", () => {
    // Must be the release from package.json, never the schema value stored in
    // config.json (which the UI used to show as a stale "2.0.0").
    const got = getConfigValue(freshCfg(), "version");
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value).toBe(readMmaVersion());
      expect(String(got.value)).toMatch(/^\d+\.\d+\.\d+/);
    }
    const desc = getFlatDicts().en["config.desc.version"] ?? "";
    expect(desc).not.toMatch(/read-only/i);
    expect(desc.length).toBeGreaterThan(0);
  });

  it("reads and writes moe.parallelSubtasks, 0 meaning auto", () => {
    const cfg = freshCfg();
    const written = setConfigValue(cfg, "moe.parallelSubtasks", "3");
    expect(written.ok).toBe(true);
    expect(cfg.moe.parallelSubtasks).toBe(3);

    const back = setConfigValue(cfg, "moe.parallelSubtasks", "0");
    expect(back.ok).toBe(true);
    // 0 = авто: значение не хранится, чтобы неотличимо от дефолта.
    expect(cfg.moe.parallelSubtasks).toBeUndefined();
    expect(getConfigValue(cfg, "moe.parallelSubtasks")).toMatchObject({ ok: true, value: 0 });
  });
});

describe("registry editor metadata", () => {
  const TAG_KEYS = [
    "security.bash.blacklist",
    "security.bash.whitelist",
    "security.bash.dangerousFlags",
    "security.bash.dangerousOperators",
    "security.paths.denied",
    "security.paths.allowed",
    "security.network.deniedDomains",
    "security.network.allowedDomains",
    "security.contentScan.dangerousPatterns",
    "tools.defaultTags",
  ];
  const TABLE_KEYS = ["pricing.overrides", "experts", "modelCapabilities"];

  it("declares tags editors for string lists", () => {
    for (const key of TAG_KEYS) expect(editorKind(key), key).toBe("tags");
  });

  it("declares a checkbox editor over a fixed option set", () => {
    expect(editorKind("security.auditNotifier.eventTypes")).toBe("checkboxes");
    const options = resolveConfigKey("security.auditNotifier.eventTypes")?.editor?.options ?? [];
    expect(options.length).toBeGreaterThan(3);
    expect(options).toContain("security_block");
  });

  it("declares table editors with typed columns", () => {
    for (const key of TABLE_KEYS) expect(editorKind(key), key).toBe("table");
    const cols = resolveConfigKey("experts")?.editor?.columns ?? [];
    expect(cols.map((c) => c.key)).toEqual(["name", "model", "tool_tags", "max_attempts", "description"]);
    expect(cols.find((c) => c.key === "tool_tags")?.array).toBe(true);
  });

  it("labels every option and column in both locales", () => {
    const dicts = getFlatDicts();
    for (const def of configDefs()) {
      for (const opt of def.editor?.options ?? []) {
        expect(typeof dicts.en[`config.enum.${opt}`], `${def.key}: ${opt} (en)`).toBe("string");
        expect(typeof dicts.ru[`config.enum.${opt}`], `${def.key}: ${opt} (ru)`).toBe("string");
      }
      for (const col of def.editor?.columns ?? []) {
        expect(typeof dicts.en[`config.field.${col.key}`], `${def.key}: ${col.key} (en)`).toBe("string");
        expect(typeof dicts.ru[`config.field.${col.key}`], `${def.key}: ${col.key} (ru)`).toBe("string");
      }
    }
  });
});
