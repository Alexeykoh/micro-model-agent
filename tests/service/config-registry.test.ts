import { describe, expect, it } from "vitest";
import { resolveConfigKey, setConfigValue } from "../../src/config/registry";
import { DEFAULTS } from "../../src/config/defaults";

describe("service config keys", () => {
  it("registers every service key", () => {
    const keys = [
      "service.port",
      "service.host",
      "service.token",
      "service.resultRetentionDays",
      "service.idempotencyTtlHours",
      "service.syncWaitMs",
      "service.maxQueueLength",
      "service.callbackTimeoutMs",
      "service.webhookSecret",
    ];
    for (const key of keys) expect(resolveConfigKey(key), key).toBeTruthy();
  });

  it("validates the port range", () => {
    const cfg = structuredClone(DEFAULTS);
    expect(setConfigValue(cfg, "service.port", "70000").ok).toBe(false);
    expect(setConfigValue(cfg, "service.port", "7331").ok).toBe(true);
  });

  it("clears an empty token to undefined", () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.service.token = "abc";
    expect(setConfigValue(cfg, "service.token", "").ok).toBe(true);
    expect(cfg.service.token).toBeUndefined();
  });
});
