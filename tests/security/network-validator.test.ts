import { isUrlAllowed, sanitizeUrl } from "../../src/modules/security/network-validator";
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
