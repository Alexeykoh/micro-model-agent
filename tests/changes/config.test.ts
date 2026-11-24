import { describe, expect, it } from "bun:test";
import { DEFAULTS } from "../../src/config/defaults";
import { configDefs } from "../../src/config/registry";
import { CONFIG_DOMAINS } from "../../src/config/domains";

describe("changes config", () => {
  it("declares defaults once", () => {
    expect(DEFAULTS.changes).toEqual({
      enabled: true,
      maxFileBytes: 2_097_152,
      maxTotalBytes: 67_108_864,
      maxRevisionsPerFile: 20,
    });
  });

  it("registers all four keys with no effects", () => {
    const keys = ["changes.enabled", "changes.maxFileBytes", "changes.maxTotalBytes", "changes.maxRevisionsPerFile"];
    for (const key of keys) {
      const def = configDefs().find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.domain).toBe("changes");
      expect(def!.effects).toEqual([]);
      expect(def!.get(structuredClone(DEFAULTS))).toBe(
        (DEFAULTS.changes as Record<string, unknown>)[key.split(".")[1]!],
      );
    }
  });

  it("persists the changes domain", () => {
    expect(CONFIG_DOMAINS.changes).toEqual(["changes"]);
  });
});
