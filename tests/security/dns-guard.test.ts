import { describe, it, expect } from "vitest";
import { isUrlAllowedAsync, isUrlAllowed } from "../../src/modules/security/network-validator";
import { resolvesToPrivate } from "../../src/modules/security/dns-guard";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";

/**
 * DNS-учитывающая SSRF-защита (аудит §2.6, план
 * `2026-10-12-harness-module-audit-fixes`, W4/Task 4.3): имя хоста может
 * резолвиться в приватный адрес.
 */

const net = DEFAULT_SECURITY_CONFIG.network;

describe("resolvesToPrivate", () => {
  it("flags a host that resolves to loopback", async () => {
    const resolver = async () => [{ address: "127.0.0.1" }];
    expect(await resolvesToPrivate("internal.attacker.example", resolver)).toBe(true);
  });

  it("flags a host that resolves to a metadata address", async () => {
    const resolver = async () => [{ address: "169.254.169.254" }];
    expect(await resolvesToPrivate("metadata.example", resolver)).toBe(true);
  });

  it("passes a public host", async () => {
    const resolver = async () => [{ address: "93.184.216.34" }];
    expect(await resolvesToPrivate("example.com", resolver)).toBe(false);
  });

  it("fails open when resolution fails", async () => {
    const resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await resolvesToPrivate("nope.example", resolver)).toBe(false);
  });
});

describe("isUrlAllowedAsync", () => {
  it("rejects a hostname that resolves to loopback", async () => {
    const resolver = async () => [{ address: "127.0.0.1" }];
    const res = await isUrlAllowedAsync("http://internal.attacker.example/", net, resolver);
    expect(res.allowed).toBe(false);
  });

  it("rejects a literal private address", async () => {
    expect((await isUrlAllowedAsync("http://169.254.169.254/latest/meta-data/", net)).allowed).toBe(
      false,
    );
    expect((await isUrlAllowedAsync("http://10.0.0.5/admin", net)).allowed).toBe(false);
    expect((await isUrlAllowedAsync("http://localhost:1234/v1/models", net)).allowed).toBe(false);
  });

  it("allows a public host", async () => {
    const resolver = async () => [{ address: "93.184.216.34" }];
    const res = await isUrlAllowedAsync("https://example.com/x", net, resolver);
    expect(res.allowed).toBe(true);
  });

  it("keeps the synchronous policy for schemes and domains", () => {
    expect(isUrlAllowed("ftp://example.com", net).allowed).toBe(false);
    expect(isUrlAllowed("https://example.com", { ...net, deniedDomains: ["example.com"] }).allowed).toBe(
      false,
    );
  });
});
