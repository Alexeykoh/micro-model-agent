import { isUrlAllowed, sanitizeUrl, isIpPrivate } from "../../src/modules/security/network-validator";
import { describe, it, expect } from "vitest";

describe("Network Validator", () => {
  describe("isUrlAllowed", () => {
    it("should allow any URL when no config provided", () => {
      const result = isUrlAllowed("https://example.com");
      expect(result.allowed).toBe(true);
    });

    it("should block denied domains", () => {
      const config = {
        enabled: true,
        deniedDomains: ["malicious.com", "evil.org"],
        allowedDomains: [],
        requestTimeout: 15000,
        maxResponseSize: 15000,
      };

      const result1 = isUrlAllowed("https://malicious.com/page", config);
      expect(result1.allowed).toBe(false);
      expect(result1.reason).toContain("denied");

      const result2 = isUrlAllowed("https://sub.malicious.com/page", config);
      expect(result2.allowed).toBe(false);
    });

    it("should allow only allowed domains when allowedDomains is non-empty", () => {
      const config = {
        enabled: true,
        deniedDomains: [],
        allowedDomains: ["github.com", "npmjs.com"],
        requestTimeout: 15000,
        maxResponseSize: 15000,
      };

      const result1 = isUrlAllowed("https://github.com/user/repo", config);
      expect(result1.allowed).toBe(true);

      const result2 = isUrlAllowed("https://example.com", config);
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toContain("not in the allowed list");
    });

    it("should block invalid URLs", () => {
      const config = {
        enabled: true,
        deniedDomains: [],
        allowedDomains: [],
        requestTimeout: 15000,
        maxResponseSize: 15000,
      };

      const result = isUrlAllowed("not-a-url", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid URL");
    });

    it("should handle URLs with ports", () => {
      const config = {
        enabled: true,
        deniedDomains: ["localhost"],
        allowedDomains: [],
        requestTimeout: 15000,
        maxResponseSize: 15000,
      };

      const result = isUrlAllowed("http://localhost:8080/api", config);
      expect(result.allowed).toBe(false);
    });

    it("blocks private IPs and link-local (SSRF)", () => {
      const config = {
        enabled: true,
        deniedDomains: [],
        allowedDomains: [],
        requestTimeout: 15000,
        maxResponseSize: 15000,
      };
      for (const u of [
        "http://127.0.0.1/",
        "http://localhost/",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://[::1]/",
      ]) {
        expect(isUrlAllowed(u, config).allowed).toBe(false);
      }
    });

    it("blocks non-http(s) schemes", () => {
      const config = {
        enabled: true,
        deniedDomains: [],
        allowedDomains: [],
        requestTimeout: 15000,
        maxResponseSize: 15000,
      };
      expect(isUrlAllowed("file:///etc/passwd", config).allowed).toBe(false);
      expect(isUrlAllowed("chrome://settings", config).allowed).toBe(false);
    });

    it("allows public https", () => {
      const config = {
        enabled: true,
        deniedDomains: [],
        allowedDomains: [],
        requestTimeout: 15000,
        maxResponseSize: 15000,
      };
      expect(isUrlAllowed("https://example.com/x", config).allowed).toBe(true);
    });
  });

  describe("sanitizeUrl", () => {
    it("should redact API keys from query parameters", () => {
      const url = "https://api.example.com/data?api_key=abc123def456";
      const sanitized = sanitizeUrl(url);
      expect(sanitized).not.toContain("abc123def456");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact tokens from query parameters", () => {
      const url = "https://api.example.com/data?token=secret123def456";
      const sanitized = sanitizeUrl(url);
      expect(sanitized).not.toContain("secret123def456");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact passwords from query parameters", () => {
      const url = "https://api.example.com/data?password=mypassword123";
      const sanitized = sanitizeUrl(url);
      expect(sanitized).not.toContain("mypassword123");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact credentials from URL", () => {
      const url = "https://user:password123@example.com";
      const sanitized = sanitizeUrl(url);
      expect(sanitized).not.toContain("user");
      expect(sanitized).not.toContain("password123");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should preserve safe URLs", () => {
      const url = "https://github.com/user/repo";
      const sanitized = sanitizeUrl(url);
      expect(sanitized).toBe(url);
    });

    it("should handle invalid URLs gracefully", () => {
      const url = "not-a-url";
      const sanitized = sanitizeUrl(url);
      expect(sanitized).not.toContain("secret");
    });
  });
});

describe("SSRF bypass regressions (audit 2026-08-26)", () => {
  it("blocks IPv6-mapped IPv4 in URL", () => {
    expect(isUrlAllowed("http://[::ffff:127.0.0.1]/x", { enabled: true } as any).allowed).toBe(false);
    expect(isUrlAllowed("http://[::ffff:7f00:1]/x", { enabled: true } as any).allowed).toBe(false);
  });

  it("blocks raw hostname forms passed directly to isIpPrivate", () => {
    // isIpPrivate is exported — callers may pass un-normalized hostnames.
    expect(isIpPrivate("2130706433")).toBe(true);   // decimal
    expect(isIpPrivate("0x7f000001")).toBe(true);   // hex
    expect(isIpPrivate("0177.0.0.1")).toBe(true);   // octal octet
    expect(isIpPrivate("127.1")).toBe(true);        // shorthand quad
    expect(isIpPrivate("0x7f.0.0.1")).toBe(true);   // mixed radix
    expect(isIpPrivate("::ffff:127.0.0.1")).toBe(true);
  });

  it("does not block public domains or IPs", () => {
    expect(isIpPrivate("example.com")).toBe(false);
    expect(isIpPrivate("8.8.8.8")).toBe(false);
    expect(isIpPrivate("2606:4700::6810:85e5")).toBe(false);
  });

  it("blocks expanded/non-canonical IPv6 loopback and mapped forms", () => {
    expect(isIpPrivate("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isIpPrivate("::")).toBe(true);
    expect(isIpPrivate("::ffff:0:7f00:1")).toBe(true);
    expect(isIpPrivate("fe80::1")).toBe(true);
    expect(isIpPrivate("fd00::1")).toBe(true);
    expect(isIpPrivate("0:0:0:0:0:0:0:1%eth0")).toBe(true);
    expect(isUrlAllowed("http://[0:0:0:0:0:0:0:1]/x", { enabled: true } as any).allowed).toBe(false);
  });
});
