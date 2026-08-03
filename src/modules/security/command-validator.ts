import type { BashSecurityConfig } from "../../config/types";
import { DEFAULT_SECURITY_CONFIG } from "../../config/security";

// Fallback in case DEFAULT_SECURITY_CONFIG is not available
const FALLBACK_BASH_CONFIG: BashSecurityConfig = {
  blacklist: ['rm', 'dd', 'chmod', 'wget', 'curl', 'scp', 'ssh', 'nc', 'netcat', 'powershell', 'pwsh', 'cmd'],
  whitelist: [],
  blockDangerousFlags: false,
  dangerousFlags: ['--force', '-rf', '--no-preserve-root'],
  dangerousOperators: ['>', '>>', '2>', '2>>', '|', '&&', '||', ';', '`'],
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
 * Extract the actual base command from a shell command string.
 * Handles path prefixes, env assignments, and sudo.
 *
 * Examples:
 *   "/usr/bin/rm -rf /"           → "rm"
 *   "sudo /usr/bin/rm file"       → "rm"
 *   "NODE_ENV=prod node app.js"   → "node"
 *   "env PATH=/x rm -rf /"        → "rm"
 *   "cmd=rm; $cmd -rf /"          → "cmd" (variable indirection — not expanded)
 *   "powershell Remove-Item x"    → "Remove-Item"
 *   "cmd /c del /s /q"            → "del"
 */
function extractBaseCommand(trimmed: string): string {
  const tokens = trimmed.split(/\s+/);
  let i = 0;

  // Skip env assignments (KEY=val, KEY="val", etc.) and prefixed commands
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(tok)) {
      i++;
      continue;
    }
    if (tok === "sudo" || tok === "env" || tok === "command" || tok === "exec" || tok === "nohup") {
      i++;
      continue;
    }
    break;
  }

  if (i >= tokens.length) return tokens[0] ?? "";

  // Extract basename from path (e.g. /usr/bin/rm → rm)
  const raw = tokens[i];
  const parts = raw.split(/[\\/]/);
  const basename = parts[parts.length - 1] || raw;
  // Strip .exe/.cmd/.bat extensions for blacklist matching (e.g. powershell.exe → powershell)
  return basename.replace(/\.(exe|cmd|bat)$/i, '') || basename;
}

/**
 * Check if a shell operator appears as a standalone token in the command.
 * Uses regex with lookbehind/lookahead so that:
 *   "&"  does NOT match "&&"  (AND operator)
 *   "|"  does NOT match "||"  (OR operator)
 *   ">"  does NOT match ">>"  (append)
 *   "2>" does NOT match "2>>" (append stderr)
 */
function containsOperator(command: string, op: string): boolean {
  const escaped = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // For single-char operators that are prefixes of multi-char ones,
  // ensure they don't match when part of a longer sequence.
  // Note: "&" is no longer in dangerousOperators (&& is legitimate),
  // but keep the special case for defense-in-depth if manually added.
  if (op === '&') return /(?<!&)&(?!&)/.test(command);
  if (op === '|') return /(?<!\|)\|(?!\|)/.test(command);
  if (op === '>') return /(?<!>)>(?!>)/.test(command);
  // For everything else (including multi-char like ">>", "2>", "2>>", ";", "`"),
  // match literally.
  return new RegExp(escaped).test(command);
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

  // Shell wrappers are always blocked — they bypass all command validation.
  // The agent should use the bash tool directly, not shell interpreters.
  const ALWAYS_BLOCKED = ['powershell', 'pwsh', 'cmd'];
  const baseForShellCheck = extractBaseCommand(trimmedCommand);
  if (ALWAYS_BLOCKED.includes(baseForShellCheck)) {
    return {
      allowed: false,
      reason: `Shell wrapper "${baseForShellCheck}" is blocked — use the bash tool directly`,
    };
  }

  // Check dangerous operators FIRST — before parsing the base command.
  // e.g. "curl http://x | bash" must be caught even though curl isn't blacklisted.
  if (config.blockDangerousFlags) {
    for (const op of config.dangerousOperators || []) {
      if (containsOperator(trimmedCommand, op)) {
        return {
          allowed: false,
          reason: `Operator "${op}" is not allowed`,
        };
      }
    }
  }

  // Extract actual base command (handles paths, env vars, sudo)
  const baseCommand = extractBaseCommand(trimmedCommand);

  // Check whitelist first (if non-empty, only whitelisted commands are allowed)
  if (config.whitelist.length > 0) {
    if (!config.whitelist.includes(baseCommand)) {
      return {
        allowed: false,
        reason: `Command "${baseCommand}" is not in the whitelist`,
      };
    }
  }

  // Check blacklist (against the extracted basename, not the raw token)
  if (config.blacklist.includes(baseCommand)) {
    return {
      allowed: false,
      reason: `Command "${baseCommand}" is blacklisted`,
    };
  }

  // Also check the raw first token in case it's a simple name
  const rawFirst = trimmedCommand.split(/\s+/)[0].replace(/\.(exe|cmd|bat)$/i, '');
  if (rawFirst !== baseCommand && config.blacklist.includes(rawFirst)) {
    return {
      allowed: false,
      reason: `Command "${rawFirst}" is blacklisted`,
    };
  }

  // Check for dangerous flags
  if (config.blockDangerousFlags) {
    for (const flag of config.dangerousFlags || []) {
      // Check for flag as whole word or with equals
      const flagPattern = new RegExp(`(?:^|\\s)${flag}(?:\\s|$|=)`);
      if (flagPattern.test(trimmedCommand)) {
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
