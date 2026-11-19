import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config/defaults";
import type { ServiceConfig } from "../../src/config/types";
import { resolveServiceTls, tlsPolicyError } from "../../src/modules/service/http/tls";
import { startAgentService } from "../../src/modules/service/module";
import { cleanupServiceDir, makeServiceDeps, tempServiceDir } from "./harness";

const ENV_KEYS = ["MMA_SERVICE_TLS_CERT", "MMA_SERVICE_TLS_KEY", "MMA_SERVICE_TLS_PROXY"] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function service(patch: Partial<ServiceConfig> = {}): ServiceConfig {
  return { ...structuredClone(DEFAULTS.service), ...patch };
}

describe("service TLS (W6)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("stays on HTTP when no cert/key is configured", () => {
    const tls = resolveServiceTls(service());
    expect(tls).toMatchObject({ enabled: false, scheme: "http", terminatedByProxy: false });
    expect(tlsPolicyError(tls)).toContain("TLS");
  });

  it("enables HTTPS when both PEM paths are readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-tls-"));
    try {
      const cert = join(dir, "cert.pem");
      const key = join(dir, "key.pem");
      writeFileSync(cert, "cert", "utf8");
      writeFileSync(key, "key", "utf8");
      const tls = resolveServiceTls(service({ tls: { cert, key } }));
      expect(tls.enabled).toBe(true);
      expect(tls.scheme).toBe("https");
      expect(tls.options?.cert.toString()).toBe("cert");
      expect(tlsPolicyError(tls)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a lone cert and unreadable files", () => {
    expect(() => resolveServiceTls(service({ tls: { cert: "cert.pem" } }))).toThrow(
      /both cert and key/,
    );
    expect(() =>
      resolveServiceTls(service({ tls: { cert: "missing.pem", key: "missing.key" } })),
    ).toThrow(/cannot read/);
  });

  it("accepts non-loopback only when TLS is terminated by a proxy", () => {
    const tls = resolveServiceTls(service({ tls: { terminatedByProxy: true } }));
    expect(tls.terminatedByProxy).toBe(true);
    expect(tlsPolicyError(tls)).toBeUndefined();
  });

  it("refuses a non-loopback bind without TLS", async () => {
    const dir = tempServiceDir();
    const svc = startAgentService(
      makeServiceDeps({
        dir,
        patch: (c) => {
          c.service.host = "0.0.0.0";
          c.service.token = "tok";
        },
      }),
    );
    try {
      await expect(svc.url).rejects.toThrow(/TLS/);
    } finally {
      svc.stop();
      cleanupServiceDir(dir);
    }
  });
});
