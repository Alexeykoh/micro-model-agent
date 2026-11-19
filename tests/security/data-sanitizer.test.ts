import {
  sanitizeLogMessage,
  sanitizeLogMessageTargeted,
  sanitizeCommand,
  sanitizeUrl,
} from "../../src/modules/security/data-sanitizer";
import { describe, it, expect } from "vitest";

describe("Data Sanitizer", () => {
  describe("sanitizeLogMessageTargeted", () => {
    it("redacts real secrets (key=value and prefixed tokens)", () => {
      expect(sanitizeLogMessageTargeted('api_key: sk-abcdefghij0123456789')).toContain("[REDACTED]");
      expect(sanitizeLogMessageTargeted("Bearer abcdefghij0123456789xyz")).toContain("[REDACTED]");
    });

    it("keeps long non-secret tokens (URLs, slugs) intact", () => {
      const longPath = "https://catalog.example.com/bike/specialized/rockhopper-27.5-m-2023-gloss";
      expect(sanitizeLogMessageTargeted(longPath)).toBe(longPath);
      const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
      expect(sanitizeLogMessageTargeted(`hash ${sha}`)).toBe(`hash ${sha}`);
    });
  });

  describe("sanitizeLogMessage", () => {
    it("should redact API keys", () => {
      const message = "Using API key: sk-abc123def456789ghi012jkl345";
      const sanitized = sanitizeLogMessage(message);
      expect(sanitized).not.toContain("sk-abc123def456789ghi012jkl345");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact tokens", () => {
      // Token needs to be in key=value format or be a known pattern
      const message = "Token: abc123xyz456def7890123456";
      const sanitized = sanitizeLogMessage(message);
      expect(sanitized).not.toContain("abc123xyz456def7890123456");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact passwords", () => {
      const message = "Password: mysecret123";
      const sanitized = sanitizeLogMessage(message);
      expect(sanitized).not.toContain("mysecret123");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact secrets", () => {
      const message = "Secret: topsecret12345678901234567890";
      const sanitized = sanitizeLogMessage(message);
      expect(sanitized).not.toContain("topsecret12345678901234567890");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact GitHub tokens", () => {
      const message = "GitHub token: ghp_abc123def456789ghi012jkl345";
      const sanitized = sanitizeLogMessage(message);
      expect(sanitized).not.toContain("ghp_abc123def456789ghi012jkl345");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact AWS keys", () => {
      const message = "AWS key: AKIAIOSFODNN7EXAMPLEKEY";
      const sanitized = sanitizeLogMessage(message);
      expect(sanitized).not.toContain("AKIAIOSFODNN7EXAMPLEKEY");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should preserve safe messages", () => {
      const message = "Starting build process...";
      const sanitized = sanitizeLogMessage(message);
      expect(sanitized).toBe(message);
    });

    it("should handle multiple secrets in one message", () => {
      const message = "API key: sk-12345678901234567890, Token: abc45678901234567890";
      const sanitized = sanitizeLogMessage(message);
      expect(sanitized).not.toContain("sk-12345678901234567890");
      expect(sanitized).not.toContain("abc45678901234567890");
      expect(sanitized).toContain("[REDACTED]");
    });
  });

  describe("sanitizeCommand", () => {
    it("should redact secrets from commands", () => {
      const command = 'curl -H "api_key: abc123def456" http://example.com';
      const sanitized = sanitizeCommand(command);
      expect(sanitized).not.toContain("abc123def456");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should preserve safe commands", () => {
      const command = "git status";
      const sanitized = sanitizeCommand(command);
      expect(sanitized).toBe(command);
    });
  });

  describe("sanitizeUrl", () => {
    it("should redact secrets from URLs", () => {
      const url = "https://example.com/api?api_key=abc123def456";
      const sanitized = sanitizeUrl(url);
      expect(sanitized).not.toContain("abc123def456");
      // URL may have encoded [REDACTED] or plain [REDACTED]
      expect(sanitized).toMatch(/REDACTED/i);
    });

    it("should preserve safe URLs", () => {
      const url = "https://github.com/user/repo";
      const sanitized = sanitizeUrl(url);
      expect(sanitized).toBe(url);
    });
  });
});
