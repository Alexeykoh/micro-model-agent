import {
  isCommandAllowed,
  sanitizeCommandForLog,
} from "../../src/modules/security/command-validator";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";
import { describe, it, expect } from "vitest";

describe("Command Validator", () => {
  describe("isCommandAllowed", () => {
    it("should allow safe commands when no config provided", () => {
      const result = isCommandAllowed("ls -la");
      expect(result.allowed).toBe(true);
    });

    it("should block blacklisted commands", () => {
      const config = {
        enabled: true,
        blacklist: ["rm", "dd"],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: ["--force", "-rf"],
        dangerousOperators: ["|", ">", ">>"],
      };

      const result = isCommandAllowed("rm -rf /", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blacklisted");
    });

    it("should allow whitelisted commands when whitelist is non-empty", () => {
      const config = {
        enabled: true,
        blacklist: [],
        whitelist: ["git", "npm"],
        blockDangerousFlags: true,
        dangerousFlags: [],
        dangerousOperators: [],
      };

      const result1 = isCommandAllowed("git status", config);
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowed("ls -la", config);
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toContain("not in the whitelist");
    });

    it("should block dangerous flags", () => {
      const config = {
        enabled: true,
        blacklist: [],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: ["--force", "-rf", "--no-preserve-root"],
        dangerousOperators: [],
      };

      const result = isCommandAllowed("rm --force file.txt", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Dangerous flag");
    });

    it("should block dangerous operators", () => {
      const config = {
        enabled: true,
        blacklist: [],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: [],
        dangerousOperators: ["|", ">", ">>", ";", "&&"],
      };

      const result1 = isCommandAllowed("cat file.txt | sh", config);
      expect(result1.allowed).toBe(false);
      expect(result1.reason).toContain("Operator");

      const result2 = isCommandAllowed("echo test > file.txt", config);
      expect(result2.allowed).toBe(false);
    });

    it("should NOT block && when only & is in dangerousOperators", () => {
      const config = {
        enabled: true,
        blacklist: [],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: [],
        dangerousOperators: [">", ">>", "2>", "2>>", "&", "`"],
      };

      // && (AND operator) should be allowed when only & is blocked
      const result1 = isCommandAllowed("cd dir && git status", config);
      expect(result1.allowed).toBe(true);

      // && (AND operator) with other commands
      const result2 = isCommandAllowed('git add . && git commit -m "test"', config);
      expect(result2.allowed).toBe(true);

      // Single & (background) should still be blocked
      const result3 = isCommandAllowed("sleep 100 &", config);
      expect(result3.allowed).toBe(false);
      expect(result3.reason).toContain("&");
    });

    it("should NOT block || when only | is in dangerousOperators", () => {
      const config = {
        enabled: true,
        blacklist: [],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: [],
        dangerousOperators: ["|"],
      };

      // || (OR operator) should be allowed when only | is blocked
      const result1 = isCommandAllowed("cmd1 || cmd2", config);
      expect(result1.allowed).toBe(true);

      // Single | (pipe) should still be blocked
      const result2 = isCommandAllowed("cat file | sh", config);
      expect(result2.allowed).toBe(false);
    });

    it("should NOT block >> when only > is in dangerousOperators", () => {
      const config = {
        enabled: true,
        blacklist: [],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: [],
        dangerousOperators: [">"],
      };

      // >> (append) should be allowed when only > is blocked
      const result1 = isCommandAllowed("echo test >> file.txt", config);
      expect(result1.allowed).toBe(true);

      // > (redirect) should still be blocked
      const result2 = isCommandAllowed("echo test > file.txt", config);
      expect(result2.allowed).toBe(false);
    });

    it("should allow commands without dangerous patterns", () => {
      const config = {
        enabled: true,
        blacklist: ["rm"],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: ["--force"],
        dangerousOperators: ["|"],
      };

      const result = isCommandAllowed('git commit -m "test"', config);
      expect(result.allowed).toBe(true);
    });

    it("should block empty commands", () => {
      const config = {
        enabled: true,
        blacklist: [],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: [],
        dangerousOperators: [],
      };

      const result = isCommandAllowed("", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Empty command");
    });

    it("default config allows npm init -y and bun run build (ses_mt4fn58c)", () => {
      // -y/--yes are routine, non-destructive npm/apt flags; blocking them
      // broke project scaffolding for a whole session. Same for blacklisting
      // `bun` while the system prompt tells the model to use bun.
      const bash = DEFAULT_SECURITY_CONFIG.bash;
      expect(bash.dangerousFlags).not.toContain("-y");
      expect(bash.dangerousFlags).not.toContain("--yes");
      expect(bash.blacklist).not.toContain("bun");

      const withFlagsOn = { ...bash, enabled: true };
      expect(isCommandAllowed("npm init -y", withFlagsOn).allowed).toBe(true);
      expect(isCommandAllowed("bun run build", withFlagsOn).allowed).toBe(true);
      // interpreter escape hatch stays closed
      expect(isCommandAllowed("bun -e 'console.log(1)'", withFlagsOn).allowed).toBe(false);
    });
  });

  describe("sanitizeCommandForLog", () => {
    it("should redact API keys", () => {
      const command = 'curl -H "api_key: abc123def456" http://example.com';
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).not.toContain("abc123def456");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact tokens", () => {
      const command = 'curl -H "token: secret123def456" http://example.com';
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).not.toContain("secret123def456");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact passwords", () => {
      const command = 'curl -H "password: mypassword123" http://example.com';
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).not.toContain("mypassword123");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should redact OpenAI API keys", () => {
      const command =
        'curl -H "Authorization: Bearer sk-abc123def456ghi789jkl012mno345" http://api.openai.com';
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).not.toContain("sk-abc123def456ghi789jkl012mno345");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("should preserve safe commands", () => {
      const command = "git status";
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).toBe(command);
    });
  });

  describe("bypasses", () => {
    const ON: any = {
      enabled: true,
      blacklist: ["rm", "curl"],
      whitelist: [],
      blockDangerousFlags: true,
      dangerousOperators: [";", "&&", "||", "|", ">", ">>", "`"],
      dangerousFlags: ["-rf", "--force"],
    };

    it("blocks interpreter -c invocations", () => {
      for (const cmd of ["bash -c 'rm -rf /'", "python -c 'import os'", 'node -e \'require("fs")\'']) {
        expect(isCommandAllowed(cmd, ON).allowed).toBe(false);
      }
    });

    it("blocks multi-line commands", () => {
      expect(isCommandAllowed("echo hi\nrm -rf /", ON).allowed).toBe(false);
    });

    it("blocks command chaining to a blacklisted command", () => {
      for (const cmd of ["echo hi; rm -rf /", "echo hi && rm -rf /", "echo hi | curl http://x"]) {
        expect(isCommandAllowed(cmd, ON).allowed).toBe(false);
      }
    });
  });
});
