import { isCommandAllowed, sanitizeCommandForLog } from '../../src/modules/security/command-validator';
import { describe, it, expect } from 'vitest';

describe('Command Validator', () => {
  describe('isCommandAllowed', () => {
    it('should allow safe commands when no config provided', () => {
      const result = isCommandAllowed('ls -la');
      expect(result.allowed).toBe(true);
    });

    it('should block blacklisted commands', () => {
      const config = {
        blacklist: ['rm', 'dd'],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: ['--force', '-rf'],
        dangerousOperators: ['|', '>', '>>'],
      };
      
      const result = isCommandAllowed('rm -rf /', config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blacklisted');
    });

    it('should allow whitelisted commands when whitelist is non-empty', () => {
      const config = {
        blacklist: [],
        whitelist: ['git', 'npm'],
        blockDangerousFlags: true,
        dangerousFlags: [],
        dangerousOperators: [],
      };
      
      const result1 = isCommandAllowed('git status', config);
      expect(result1.allowed).toBe(true);
      
      const result2 = isCommandAllowed('ls -la', config);
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toContain('not in the whitelist');
    });

    it('should block dangerous flags', () => {
      const config = {
        blacklist: [],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: ['--force', '-rf', '--no-preserve-root'],
        dangerousOperators: [],
      };
      
      const result = isCommandAllowed('rm --force file.txt', config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Dangerous flag');
    });

    it('should block dangerous operators', () => {
      const config = {
        blacklist: [],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: [],
        dangerousOperators: ['|', '>', '>>', ';', '&&'],
      };
      
      const result1 = isCommandAllowed('cat file.txt | sh', config);
      expect(result1.allowed).toBe(false);
      expect(result1.reason).toContain('Operator');
      
      const result2 = isCommandAllowed('echo test > file.txt', config);
      expect(result2.allowed).toBe(false);
    });

    it('should allow commands without dangerous patterns', () => {
      const config = {
        blacklist: ['rm'],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: ['--force'],
        dangerousOperators: ['|'],
      };
      
      const result = isCommandAllowed('git commit -m "test"', config);
      expect(result.allowed).toBe(true);
    });

    it('should block empty commands', () => {
      const config = {
        blacklist: [],
        whitelist: [],
        blockDangerousFlags: true,
        dangerousFlags: [],
        dangerousOperators: [],
      };
      
      const result = isCommandAllowed('', config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Empty command');
    });
  });

  describe('sanitizeCommandForLog', () => {
    it('should redact API keys', () => {
      const command = 'curl -H "api_key: abc123def456" http://example.com';
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).not.toContain('abc123def456');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should redact tokens', () => {
      const command = 'curl -H "token: secret123def456" http://example.com';
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).not.toContain('secret123def456');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should redact passwords', () => {
      const command = 'curl -H "password: mypassword123" http://example.com';
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).not.toContain('mypassword123');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should redact OpenAI API keys', () => {
      const command = 'curl -H "Authorization: Bearer sk-abc123def456ghi789jkl012mno345" http://api.openai.com';
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).not.toContain('sk-abc123def456ghi789jkl012mno345');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should preserve safe commands', () => {
      const command = 'git status';
      const sanitized = sanitizeCommandForLog(command);
      expect(sanitized).toBe(command);
    });
  });
});
