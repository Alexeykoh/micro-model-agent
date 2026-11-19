import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDaemonToken, rotateDaemonToken } from "../src/modules/daemon/protocol";

const ENV_KEYS = ["MMA_DAEMON_TOKEN", "MMA_SERVICE_TOKEN"] as const;

describe("daemon token rotation (W6)", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("writes a fresh token that the client reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-token-"));
    try {
      const file = join(dir, "daemon.token");
      const token = rotateDaemonToken(file);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(file, "utf8").trim()).toBe(token);
      expect(readDaemonToken(file)).toBe(token);

      const next = rotateDaemonToken(file);
      expect(next).not.toBe(token);
      expect(readDaemonToken(file)).toBe(next);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
