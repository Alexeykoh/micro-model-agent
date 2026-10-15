import { describe, it, expect } from "vitest";
import { checkOutboundUrl, fetchOutbound, OutboundPolicyError } from "../../src/modules/security/outbound-policy";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";
import type { Diagnostic } from "../../src/output/types";

const net = DEFAULT_SECURITY_CONFIG.network;
const source = "module:service" as const;

function opts(extra: Partial<Parameters<typeof checkOutboundUrl>[2]> = {}) {
  return { operation: "service.callback", ...extra };
}

describe("outbound policy (W13)", () => {
  it("blocks loopback by default even when the network toggle is off", () => {
    // `enabled: false` описывает модельные вызовы и не открывает внутреннюю
    // сеть для вызовов каркаса.
    const check = checkOutboundUrl(
      "http://127.0.0.1:9200/_search",
      source,
      opts({ networkConfig: { ...net, enabled: false } }),
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("private address");
  });

  it("blocks private ranges, link-local and localhost by name", () => {
    for (const url of [
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://localhost:8080/",
      "http://2130706433/", // 127.0.0.1 as int
    ]) {
      expect(checkOutboundUrl(url, source, opts({ networkConfig: net })).allowed, url).toBe(false);
    }
  });

  it("allows loopback only with the explicit config flag", () => {
    const check = checkOutboundUrl(
      "http://127.0.0.1:9200/hook",
      source,
      opts({ networkConfig: { ...net, allowPrivateOutbound: true } }),
    );
    expect(check.allowed).toBe(true);
  });

  it("rejects non-http schemes and malformed URLs", () => {
    expect(checkOutboundUrl("file:///etc/passwd", source, opts({ networkConfig: net })).allowed).toBe(false);
    expect(checkOutboundUrl("ftp://example.com/", source, opts({ networkConfig: net })).allowed).toBe(false);
    expect(checkOutboundUrl("not a url", source, opts({ networkConfig: net })).allowed).toBe(false);
  });

  it("applies denied and allowed domain lists", () => {
    const denied = checkOutboundUrl("https://evil.example/x", source, opts({
      networkConfig: { ...net, deniedDomains: ["evil.example"] },
    }));
    expect(denied.allowed).toBe(false);
    const allowed = checkOutboundUrl("https://ok.example/x", source, opts({
      networkConfig: { ...net, allowedDomains: ["ok.example"] },
    }));
    expect(allowed.allowed).toBe(true);
    const offList = checkOutboundUrl("https://other.example/x", source, opts({
      networkConfig: { ...net, allowedDomains: ["ok.example"] },
    }));
    expect(offList.allowed).toBe(false);
  });

  it("emits a diagnostic with a cause on refusal (INV-14)", () => {
    const seen: Diagnostic[] = [];
    checkOutboundUrl("http://127.0.0.1/", source, opts({
      networkConfig: net,
      onDiagnostic: (d) => seen.push(d),
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      source: "module:service",
      operation: "service.callback",
      kind: "blocked",
    });
    expect(seen[0].cause).toContain("private address");
  });

  it("fetchOutbound throws before any network call", async () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        fetchOutbound("http://127.0.0.1:1/x", source, opts({ networkConfig: net })),
      ).rejects.toBeInstanceOf(OutboundPolicyError);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});