// Loopback-доступ для веб-разработки (TODO §1.12, спека 2026-11-03).
//
// Флаг `security.network.allowLoopback` снимает ТОЛЬКО дефолтный loopback-deny
// и private-IP блок для loopback-адреса. Приватная LAN, внешние deny-домены и
// схемы остаются закрытыми; по умолчанию всё запрещено.
import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";
import {
  isUrlAllowed,
  isUrlAllowedAsync,
} from "../../src/modules/security/network-validator";
import { checkOutboundUrl } from "../../src/modules/security/outbound-policy";
import { checkBrowserUrl } from "../../src/modules/browser/url-policy";
import type { NetworkSecurityConfig } from "../../src/config/types";

const base = DEFAULT_SECURITY_CONFIG.network;

function net(extra: Partial<NetworkSecurityConfig> = {}): NetworkSecurityConfig {
  return { ...base, ...extra };
}

const loopbackUrls = ["http://localhost:5173/", "http://127.0.0.1:3000/", "http://[::1]:8080/"];

describe("loopback web access (allowLoopback)", () => {
  it("defaults to false and keeps loopback denied", () => {
    expect(DEFAULT_SECURITY_CONFIG.network.allowLoopback).toBe(false);
    for (const url of loopbackUrls) {
      expect(isUrlAllowed(url, net()).allowed, url).toBe(false);
    }
  });

  it("allows loopback literals only with the flag on", () => {
    for (const url of loopbackUrls) {
      expect(isUrlAllowed(url, net({ allowLoopback: true })).allowed, url).toBe(true);
    }
  });

  it("still blocks private LAN and external denied domains with the flag on", () => {
    const cfg = net({ allowLoopback: true, deniedDomains: ["localhost", "127.0.0.1", "::1", "evil.example"] });
    for (const url of ["http://10.0.0.1/", "http://192.168.1.1/", "https://evil.example/x"]) {
      expect(isUrlAllowed(url, cfg).allowed, url).toBe(false);
    }
  });

  it("keeps non-http schemes and the allowed-domains list enforced", () => {
    const cfg = net({ allowLoopback: true, allowedDomains: ["example.com"] });
    expect(isUrlAllowed("file:///etc/passwd", cfg).allowed).toBe(false);
    // allowLoopback снимает deny/private для loopback, но не allowlist.
    expect(isUrlAllowed("http://127.0.0.1/", cfg).allowed).toBe(false);
  });

  it("behaves the same through the DNS-aware path for a loopback literal", async () => {
    expect((await isUrlAllowedAsync("http://127.0.0.1:3000/", net())).allowed).toBe(false);
    expect(
      (await isUrlAllowedAsync("http://127.0.0.1:3000/", net({ allowLoopback: true }))).allowed,
    ).toBe(true);
    expect(
      (await isUrlAllowedAsync("http://localhost:5173/", net({ allowLoopback: true }))).allowed,
    ).toBe(true);
  });

  it("does not open the framework outbound policy beyond loopback", () => {
    const opts = { operation: "service.callback" };
    expect(
      checkOutboundUrl("http://127.0.0.1:9200/hook", "module:service", {
        ...opts,
        networkConfig: net(),
      }).allowed,
    ).toBe(false);
    expect(
      checkOutboundUrl("http://127.0.0.1:9200/hook", "module:service", {
        ...opts,
        networkConfig: net({ allowLoopback: true }),
      }).allowed,
    ).toBe(true);
    expect(
      checkOutboundUrl("http://10.0.0.5/", "module:service", {
        ...opts,
        networkConfig: net({ allowLoopback: true }),
      }).allowed,
    ).toBe(false);
  });

  it("reaches web tools and the browser url-policy", async () => {
    const off = await checkBrowserUrl("http://localhost:5173/", net());
    expect(off.ok).toBe(false);
    const on = await checkBrowserUrl("http://localhost:5173/", net({ allowLoopback: true }));
    expect(on).toEqual({ ok: true, url: "http://localhost:5173/" });
  });
});
