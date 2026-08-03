import type { SecurityConfig, SessionEncryptionConfig, AuditNotifierConfig } from "./types";

/**
 * Default security configuration for MMA.
 * These settings provide a balance between security and usability.
 */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  bash: {
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
    ],
    // If whitelist is non-empty, only these commands are allowed
    whitelist: [],
    // Block dangerous flags like --force, -rf, etc.
    // Disabled by default — enable in config if needed.
    blockDangerousFlags: false,
    // Log all executed commands to audit log
    logCommands: true,
    // Dangerous flags that are always blocked
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
      "--yes",
      "-y",
      "--no-confirm",
    ],
    // Dangerous operators that are always blocked
    // Note: "&" (background) is not blocked — "&&" (AND) is a legitimate shell operator.
    // Single "&" for backgrounding is harmless and blocking it breaks "cd dir && npm install".
    dangerousOperators: [">", ">>", "2>", "2>>", "`"],
  },
  paths: {
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
     enabled: true,
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
     minSeverity: 'medium',
     eventTypes: [
       'security_block',
       'bash_command',
       'file_operation',
       'network_request',
     ],
     maxRetries: 3,
     webhookTimeout: 5000,
   },
};

/**
 * Merge user-provided security config with defaults.
 * User config takes precedence over defaults.
 */
export function mergeSecurityConfig(
  userConfig?: Partial<SecurityConfig>,
): SecurityConfig {
  return {
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
    maxRecursionDepth:
      userConfig?.maxRecursionDepth ?? DEFAULT_SECURITY_CONFIG.maxRecursionDepth,
    maxFileOperations:
      userConfig?.maxFileOperations ?? DEFAULT_SECURITY_CONFIG.maxFileOperations,
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
