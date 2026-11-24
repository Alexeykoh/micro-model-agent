import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULTS } from "../../src/config/defaults";
import { configDefs, setConfigValue } from "../../src/config/registry";
import { CONFIG_DOMAINS, loadDomainFiles, saveDomainFiles } from "../../src/config/domains";
import type { AppConfig } from "../../src/config/types";

const CASES = [
  {
    key: "changes.enabled", field: "enabled", valueType: "bool",
    min: undefined, max: undefined, step: undefined, raw: "false", value: false,
    expected: { ...DEFAULTS.changes, enabled: false },
  },
  {
    key: "changes.maxFileBytes", field: "maxFileBytes", valueType: "int",
    min: 1024, max: 20_971_520, step: 1024, raw: "4096", value: 4096,
    expected: { ...DEFAULTS.changes, maxFileBytes: 4096 },
  },
  {
    key: "changes.maxTotalBytes", field: "maxTotalBytes", valueType: "int",
    min: 1_048_576, max: 536_870_912, step: 1_048_576, raw: "8388608", value: 8_388_608,
    expected: { ...DEFAULTS.changes, maxTotalBytes: 8_388_608 },
  },
  {
    key: "changes.maxRevisionsPerFile", field: "maxRevisionsPerFile", valueType: "int",
    min: 1, max: 200, step: 1, raw: "7", value: 7,
    expected: { ...DEFAULTS.changes, maxRevisionsPerFile: 7 },
  },
] as const;

describe("changes config", () => {
  it("declares defaults once", () => {
    expect(DEFAULTS.changes).toEqual({
      enabled: true,
      maxFileBytes: 2_097_152,
      maxTotalBytes: 67_108_864,
      maxRevisionsPerFile: 20,
    });
  });

  it("declares exactly four typed and bounded keys with no effects", () => {
    const defs = configDefs().filter((d) => d.key.startsWith("changes."));
    expect(defs.map((d) => d.key)).toEqual(CASES.map((c) => c.key));
    for (const c of CASES) {
      const def = defs.find((d) => d.key === c.key);
      expect(def).toBeDefined();
      expect({
        valueType: def!.valueType,
        min: def!.min,
        max: def!.max,
        step: def!.step,
      }).toEqual({ valueType: c.valueType, min: c.min, max: c.max, step: c.step });
      expect(def!.domain).toBe("changes");
      expect(def!.effects).toEqual([]);
      expect(def!.get(structuredClone(DEFAULTS))).toBe(DEFAULTS.changes?.[c.field]);
    }
  });

  it("writes each key into a partial config and preserves sibling defaults", () => {
    for (const c of CASES) {
      const config = { changes: {} } as AppConfig;
      expect(setConfigValue(config, c.key, c.raw)).toMatchObject({
        ok: true,
        key: c.key,
        value: c.value,
        effects: [],
      });
      expect(config.changes).toEqual(c.expected);
    }
  });

  it("rejects out-of-range integers without mutating config", () => {
    for (const c of CASES.filter((c) => c.valueType === "int")) {
      const config = { changes: {} } as AppConfig;
      const before = structuredClone(config);
      for (const raw of [String(c.min! - c.step!), String(c.max! + c.step!)]) {
        expect(setConfigValue(config, c.key, raw)).toMatchObject({
          ok: false,
          reason: "invalid-value",
          key: c.key,
        });
        expect(config).toEqual(before);
      }
    }
  });

  it("does not alias or mutate DEFAULTS.changes", () => {
    const before = structuredClone(DEFAULTS.changes);
    const config = { changes: {} } as AppConfig;
    for (const c of CASES) expect(setConfigValue(config, c.key, c.raw).ok).toBe(true);

    expect(config.changes).not.toBe(DEFAULTS.changes);
    expect(DEFAULTS.changes).toEqual(before);
    config.changes!.enabled = true;
    config.changes!.maxFileBytes = 1;
    expect(DEFAULTS.changes).toEqual(before);
  });

  it("persists the changes domain", () => {
    expect(CONFIG_DOMAINS.changes).toEqual(["changes"]);
  });

  it("round-trips changed values through domain persistence", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-changes-config-"));
    try {
      const config = { changes: {} } as AppConfig;
      for (const c of CASES) expect(setConfigValue(config, c.key, c.raw).ok).toBe(true);
      const expected = structuredClone(config.changes);

      saveDomainFiles(config, dir);
      expect(loadDomainFiles(dir)?.changes).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
