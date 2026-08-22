import type { SecurityConfig, SessionEncryptionConfig, AuditNotifierConfig } from "./types";

/**
 * Default security configuration for MMA.
 * These settings provide a balance between security and usability.
 */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enabled: true,
  bash: {
    enabled: true,
    // Commands that are always blocked (dangerous)
    blacklist: [
      "rm",
      "dd",
      "chmod",
      "wget",
      "curl",
      "scp",
      "ssh",
      "nc",
      "netcat",
      "mknod",
      "mkfifo",
      "ln",
      "chown",
      "chgrp",
      "useradd",
      "usermod",
      "passwd",
      "sudo",
      "su",
      "exec",
      "eval",
      "source",
      "kill",
      "pkill",
      "killall",
      "shutdown",
      "reboot",
      "halt",
      "poweroff",
      "format",
      "fdisk",
      "parted",
      "mkfs",
      "mount",
      "umount",
      "powershell",
      "pwsh",
      "cmd",
      "bash",
      "sh",
      "zsh",
      "dash",
      "python",
      "python3",
      "node",
      // "bun" intentionally NOT blacklisted: the system prompt tells the model
      // to run TypeScript with `bun <file.ts>` — banning it here contradicts
      // that and burned a whole session on blocked `bun run build` calls.
      // Arbitrary-code execution via flags is still caught by INTERPRETER_FLAGS.
      "perl",
      "ruby",
      "del",
      "rd",
      "erase",
      "taskkill",
    ],
    // If whitelist is non-empty, only these commands are allowed
    whitelist: [],
    // Block dangerous flags like --force, -rf, etc.
    blockDangerousFlags: true,
    // Log all executed commands to audit log
    logCommands: true,
    // Dangerous flags that are always blocked
    // Note: -y/--yes are intentionally absent — they are routine, harmless
    // confirmation flags (npm init -y, apt-get -y) and blocking them breaks
    // project scaffolding.
    dangerousFlags: [
      "--force",
      "-rf",
      "--no-preserve-root",
      "--recursive",
      "--all",
      "-x",
      "-e",
      "--delete",
      "--remove",
      "--dangerous",
      "--no-confirm",
    ],
    // Dangerous operators that are always blocked
    // Note: "&" (background) is not blocked — "&&" (AND) is a legitimate shell operator.
    // Single "&" for backgrounding is harmless and blocking it breaks "cd dir && npm install".
    dangerousOperators: [">", ">>", "2>", "2>>", ";", "&&", "||", "|", "`", "$("],
  },
  paths: {
    enabled: false,
    // Glob patterns for paths that are always denied
    denied: [
      ".git/",
      "node_modules/",
      ".env",
      "*.key",
      "*.pem",
      "*.crt",
      "*.p12",
      "*.pfx",
      "*.secret",
      "*.token",
      "package-lock.json",
      "bun.lock",
      "yarn.lock",
      "pnpm-lock.yaml",
    ],
    // If allowed is non-empty, only these paths are allowed
    allowed: [],
  },
  network: {
    // SSRF protection (private/link-local IPs, non-http schemes) is part of
    // the balanced default policy — without this flag the checks in
    // isUrlAllowed never fire and web tools can reach internal networks.
    enabled: true,
    // Domains that are always denied
    deniedDomains: ["localhost", "127.0.0.1", "::1"],
    // If allowedDomains is non-empty, only these domains are allowed
    allowedDomains: [],
    // Timeout for network requests (ms)
    requestTimeout: 15000,
    // Maximum response size (bytes)
    maxResponseSize: 15000,
  },
  // Maximum depth of subagent recursion
  maxRecursionDepth: 3,
  // Maximum number of file operations per session
  maxFileOperations: 100,
  // Rate limits for LLM requests
  rateLimits: {
    maxRequestsPerMinute: 60,
    maxParallelTasks: 5,
  },
  // Content scanning settings
  contentScan: {
    enabled: false,
    // Patterns that are considered dangerous in file content
    dangerousPatterns: [
      /eval\(/,
      /new Function\(/,
      /child_process\.exec\(/,
      /child_process\.spawn\(/,
      /require\('child_process'\)/,
      /require\('http'\)\.createServer/,
      /require\('net'\)\.createServer/,
      /process\.exit\(/,
      /while\(true\)/,
      /for\(\;\;\)/,
      /rm -rf/,
      /dd if=/,
      /chmod 777/,
    ],
  },
  // Session file encryption settings
  sessionEncryption: {
    enabled: false,
    encryptHistory: true,
    encryptSessionLog: true,
  },
  // Audit notification settings
  auditNotifier: {
    enabled: false,
    minSeverity: "medium",
    eventTypes: ["security_block", "bash_command", "file_operation", "network_request"],
    maxRetries: 3,
    webhookTimeout: 5000,
  },
};

/**
 * Merge user-provided security config with defaults.
 * User config takes precedence over defaults.
 */
export function mergeSecurityConfig(userConfig?: Partial<SecurityConfig>): SecurityConfig {
  return {
    enabled: userConfig?.enabled ?? DEFAULT_SECURITY_CONFIG.enabled,
    bash: {
      ...DEFAULT_SECURITY_CONFIG.bash,
      ...userConfig?.bash,
    },
    paths: {
      ...DEFAULT_SECURITY_CONFIG.paths,
      ...userConfig?.paths,
    },
    network: {
      ...DEFAULT_SECURITY_CONFIG.network,
      ...userConfig?.network,
    },
    maxRecursionDepth: userConfig?.maxRecursionDepth ?? DEFAULT_SECURITY_CONFIG.maxRecursionDepth,
    maxFileOperations: userConfig?.maxFileOperations ?? DEFAULT_SECURITY_CONFIG.maxFileOperations,
    rateLimits: {
      ...DEFAULT_SECURITY_CONFIG.rateLimits,
      ...userConfig?.rateLimits,
    },
    contentScan: {
      ...DEFAULT_SECURITY_CONFIG.contentScan,
      ...userConfig?.contentScan,
    },
    sessionEncryption: {
      ...DEFAULT_SECURITY_CONFIG.sessionEncryption,
      ...userConfig?.sessionEncryption,
    },
    auditNotifier: {
      ...DEFAULT_SECURITY_CONFIG.auditNotifier,
      ...userConfig?.auditNotifier,
    },
  };
}
