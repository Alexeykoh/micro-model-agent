import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  PROTOCOL_VERSION,
  protocolCompatible,
  protocolMajor,
  readDaemonToken,
  writeDaemonToken,
  DaemonClient,
} from "../src/modules/daemon/protocol";

describe("daemon wire protocol", () => {
  it("major-version compatibility gate", () => {
    expect(protocolMajor("1.2")).toBe("1");
    expect(protocolCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(protocolCompatible("2.0")).toBe(false);
    expect(protocolCompatible("0.9")).toBe(false);
  });

  it("token file round-trip (0600 semantics)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-tok-"));
    const file = join(dir, "daemon.token");
    writeDaemonToken("secret123", file);
    expect(readFileSync(file, "utf-8").trim()).toBe("secret123");
    const prev = process.env.MMA_DAEMON_TOKEN;
    delete process.env.MMA_DAEMON_TOKEN;
    delete process.env.MMA_SERVICE_TOKEN;
    try {
      expect(readDaemonToken(file)).toBe("secret123");
    } finally {
      if (prev) process.env.MMA_DAEMON_TOKEN = prev;
    }
  });

  it("thin client rejects incompatible protocol", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ status: "ok", protocol: "99" }), { status: 200 })) as typeof fetch;
    try {
      const client = new DaemonClient("http://127.0.0.1:8080");
      await expect(client.health()).rejects.toThrow(/incompatible/);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
    void writeFileSync;
  });
});
