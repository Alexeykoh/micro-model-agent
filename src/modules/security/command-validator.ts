import type { BashSecurityConfig } from "../../config/types";
import { DEFAULT_SECURITY_CONFIG } from "../../config/security";

// Fallback in case DEFAULT_SECURITY_CONFIG is not available
const FALLBACK_BASH_CONFIG: BashSecurityConfig = {
  blacklist: ['rm', 'dd', 'chmod', 'wget', 'curl', 'scp', 'ssh', 'nc', 'netcat'],
  whitelist: [],
  blockDangerousFlags: true,
  dangerousFlags: ['--force', '-rf', '--no-preserve-root'],
  dangerousOperators: ['>', '>>', '2>', '2>>', '|', '&&', '||', ';', '&', '`'],
  logCommands: true,
};

export const DEFAULT_BASH_CONFIG = DEFAULT_SECURITY_CONFIG?.bash || FALLBACK_BASH_CONFIG;

/**
 * Result of command validation
 */
export interface CommandValidationResult {
  allowed: boolean;
  reason?: string;
  sanitizedCommand?: string;
}

/**
 * Check if a command is allowed based on security configuration
 */
export function isCommandAllowed(
  command: string,
  securityConfig?: BashSecurityConfig,
): CommandValidationResult {
  // If no security config, allow everything (backward compatibility)
  let config = securityConfig || DEFAULT_BASH_CONFIG;
  
  // Ensure config has all required fields
  if (!config.blacklist || !Array.isArray(config.blacklist)) {
    config = FALLBACK_BASH_CONFIG;
  }
  
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return { allowed: false, reason: "Empty command" };
  }

  // Extract base command (first word)
  const baseCommand = trimmedCommand.split(/\s+/)[0];

  // Check whitelist first (if non-empty, only whitelisted commands are allowed)
  if (config.whitelist.length > 0) {
    if (!config.whitelist.includes(baseCommand)) {
      return {
        allowed: false,
        reason: `Command "${baseCommand}" is not in the whitelist`,
      };
    }
  }

  // Check blacklist
  if (config.blacklist.includes(baseCommand)) {
    return {
      allowed: false,
      reason: `Command "${baseCommand}" is blacklisted`,
    };
  }

  // Check for dangerous operators
  if (config.blockDangerousFlags) {
    for (const op of config.dangerousOperators || []) {
      if (command.includes(op)) {
        return {
          allowed: false,
          reason: `Operator "${op}" is not allowed`,
        };
      }
    }
  }

  // Check for dangerous flags
  if (config.blockDangerousFlags) {
    for (const flag of config.dangerousFlags || []) {
      // Check for flag as whole word or with equals
      const flagPattern = new RegExp(`(?:^|\\s)${flag}(?:\\s|$|=)`);
      if (flagPattern.test(command)) {
        return {
          allowed: false,
          reason: `Dangerous flag "${flag}" is not allowed`,
        };
      }
    }
  }

  // Command is allowed
  return { allowed: true, sanitizedCommand: command };
}

/**
 * Sanitize command for logging (remove sensitive information)
 * Uses the same patterns as sanitizeLogMessage for consistency
 */
export function sanitizeCommandForLog(command: string): string {
  // Import patterns from data-sanitizer to maintain consistency
  const patterns = [
    /(api[_-]?key|apikey|api_key)\s*[=:\s]\s*["']?([a-zA-Z0-9_-]{10,})["']?/gi,
    /(token|access[_-]?token|auth[_-]?token)\s*[=:\s]\s*["']?([a-zA-Z0-9_-]{10,})["']?/gi,
    /(password|passwd|pwd|pass)\s*[=:\s]\s*["']?([^\s"'&]+)["']?/gi,
    /(secret|private[_-]?key|secret[_-]?key)\s*[=:\s]\s*["']?([^\s"'&]+)["']?/gi,
    /\bsk-[a-zA-Z0-9_-]{20,}\b/gi,
    /\bctx7sk-[a-zA-Z0-9_-]{10,}\b/gi,
    /\bghp_[a-zA-Z0-9]{30,}\b/gi,
    /\bgithub_pat_[a-zA-Z0-9]{20,}\b/gi,
    /\bAKIA[0-9A-Z]{15,}\b/gi,
    /Bearer\s+[a-zA-Z0-9_-]{20,}/gi,
    /\b([a-zA-Z0-9_-]{30,})\b/g,
  ];

  let sanitized = command;
  for (const pattern of patterns) {
    if (pattern.toString().includes('($1')) {
      // For patterns with capture groups, use the group in replacement
      sanitized = sanitized.replace(pattern, (match, p1) => {
        return `${p1}=[REDACTED]`;
      });
    } else {
      // For simple patterns, just replace with [REDACTED]
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
  }
  return sanitized;
}
