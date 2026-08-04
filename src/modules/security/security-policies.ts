import type { SecurityConfig } from "../../config/types";
import {
  DEFAULT_SECURITY_CONFIG,
  mergeSecurityConfig,
} from "../../config/security";

/**
 * Security policy presets
 */
export type SecurityPolicyPreset =
  "strict" | "balanced" | "permissive" | "custom";

/**
 * Security policy definition
 */
export interface SecurityPolicy {
  /**
   * Policy name
   */
  name: string;
  /**
   * Policy description
   */
  description: string;
  /**
   * Preset type
   */
  preset: SecurityPolicyPreset;
  /**
   * Security configuration for this policy
   */
  config: Partial<SecurityConfig>;
  /**
   * Recommended for these use cases
   */
  recommendedFor: string[];
}

/**
 * Strict security policy - maximum security, minimum flexibility
 * Recommended for: production environments, sensitive data, multi-user systems
 */
export const STRICT_POLICY: SecurityPolicy = {
  name: "Strict",
  description:
    "Maximum security with minimal flexibility. Blocks most dangerous operations.",
  preset: "strict",
  recommendedFor: ["production", "sensitive-data", "multi-user", "enterprise"],
  config: {
    enabled: true,
    bash: {
      enabled: true,
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
        "mv",
        "cp",
      ],
      whitelist: ["ls", "cat", "echo", "grep", "find", "pwd", "whoami", "date"],
      blockDangerousFlags: true,
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
        "-R",
        "--no-clobber",
      ],
      dangerousOperators: [
        ">",
        ">>",
        "2>",
        "2>>",
        "|",
        "&&",
        "||",
        ";",
        "&",
        "`",
      ],
      logCommands: true,
    },
    paths: {
      enabled: true,
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
        ".ssh/",
        ".config/",
        ".bashrc",
        ".bash_profile",
        ".zshrc",
        ".profile",
        "/etc/",
        "/usr/",
        "/var/",
        "/bin/",
        "/sbin/",
        "/root/",
        "/home/",
      ],
      allowed: [],
    },
    network: {
      enabled: true,
      deniedDomains: [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
        "*.internal",
        "*.local",
        "192.168.*",
        "10.*",
        "172.16.*",
      ],
      allowedDomains: [],
      requestTimeout: 10000,
      maxResponseSize: 10000,
    },
    maxRecursionDepth: 2,
    maxFileOperations: 50,
    rateLimits: {
      maxRequestsPerMinute: 30,
      maxParallelTasks: 3,
    },
    contentScan: {
      enabled: true,
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
        /wget /,
        /curl /,
        /ssh /,
        /scp /,
      ],
    },
    sessionEncryption: {
      enabled: true,
      encryptHistory: true,
      encryptSessionLog: true,
    },
    auditNotifier: {
      enabled: true,
      minSeverity: "low",
      eventTypes: [
        "security_block",
        "bash_command",
        "file_operation",
        "network_request",
        "authentication",
        "configuration_change",
        "session_start",
        "session_end",
      ],
      maxRetries: 3,
    },
  },
};

/**
 * Balanced security policy - good security with reasonable flexibility
 * Recommended for: development, single-user systems, general use
 */
export const BALANCED_POLICY: SecurityPolicy = {
  name: "Balanced",
  description: "Good security with reasonable flexibility. Default policy.",
  preset: "balanced",
  recommendedFor: ["development", "single-user", "general-use", "testing"],
  config: {
    enabled: true,
    bash: {
      enabled: true,
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
        "useradd",
        "usermod",
        "passwd",
        "sudo",
        "su",
        "shutdown",
        "reboot",
        "halt",
        "poweroff",
        "format",
        "fdisk",
        "parted",
        "mkfs",
      ],
      whitelist: [],
      blockDangerousFlags: true,
      dangerousFlags: [
        "--force",
        "-rf",
        "--no-preserve-root",
        "--recursive",
        "--all",
        "--delete",
        "--remove",
        "--dangerous",
        "--yes",
        "-y",
        "--no-confirm",
      ],
      dangerousOperators: ["|", "&&", "||", ";", "&", "`"],
      logCommands: true,
    },
    paths: {
      enabled: true,
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
        ".ssh/",
      ],
      allowed: [],
    },
    network: {
      enabled: true,
      deniedDomains: [],
      allowedDomains: [],
      requestTimeout: 15000,
      maxResponseSize: 15000,
    },
    maxRecursionDepth: 3,
    maxFileOperations: 100,
    rateLimits: {
      maxRequestsPerMinute: 60,
      maxParallelTasks: 5,
    },
    contentScan: {
      enabled: true,
      dangerousPatterns: [
        /eval\(/,
        /new Function\(/,
        /child_process\.exec\(/,
        /child_process\.spawn\(/,
        /require\('child_process'\)/,
        /process\.exit\(/,
        /while\(true\)/,
        /for\(\;\;\)/,
        /rm -rf/,
        /dd if=/,
        /chmod 777/,
      ],
    },
    sessionEncryption: {
      enabled: false,
      encryptHistory: true,
      encryptSessionLog: true,
    },
    auditNotifier: {
      enabled: false,
      minSeverity: "medium",
      eventTypes: [
        "security_block",
        "bash_command",
        "file_operation",
        "network_request",
      ],
      maxRetries: 3,
    },
  },
};

/**
 * Permissive security policy - minimal security, maximum flexibility
 * Recommended for: trusted environments, local development, testing
 */
export const PERMISSIVE_POLICY: SecurityPolicy = {
  name: "Permissive",
  description: "Minimal security with maximum flexibility. Use with caution.",
  preset: "permissive",
  recommendedFor: ["trusted-environment", "local-dev", "testing", "sandbox"],
  config: {
    enabled: true,
    bash: {
      enabled: true,
      blacklist: [
        "rm",
        "dd",
        "shutdown",
        "reboot",
        "halt",
        "poweroff",
        "format",
        "fdisk",
        "parted",
        "mkfs",
      ],
      whitelist: [],
      blockDangerousFlags: false,
      dangerousFlags: ["--force", "-rf", "--no-preserve-root"],
      dangerousOperators: [],
      logCommands: true,
    },
    paths: {
      enabled: true,
      denied: [".env", "*.key", "*.pem", "*.crt", "*.p12", "*.pfx"],
      allowed: [],
    },
    network: {
      enabled: true,
      deniedDomains: [],
      allowedDomains: [],
      requestTimeout: 30000,
      maxResponseSize: 30000,
    },
    maxRecursionDepth: 5,
    maxFileOperations: 200,
    rateLimits: {
      maxRequestsPerMinute: 120,
      maxParallelTasks: 10,
    },
    contentScan: {
      enabled: true,
      dangerousPatterns: [
        /eval\(/,
        /new Function\(/,
        /while\(true\)/,
        /for\(\;\;\)/,
        /rm -rf/,
        /dd if=/,
      ],
    },
    sessionEncryption: {
      enabled: false,
      encryptHistory: false,
      encryptSessionLog: false,
    },
    auditNotifier: {
      enabled: false,
      minSeverity: "high",
      eventTypes: ["security_block"],
      maxRetries: 2,
    },
  },
};

/**
 * All available security policies
 */
export const SECURITY_POLICIES: Record<SecurityPolicyPreset, SecurityPolicy> = {
  strict: STRICT_POLICY,
  balanced: BALANCED_POLICY,
  permissive: PERMISSIVE_POLICY,
  custom: {
    name: "Custom",
    description: "Custom security configuration",
    preset: "custom",
    recommendedFor: [],
    config: {},
  },
};

/**
 * Security policy manager
 */
export class SecurityPolicyManager {
  private currentPolicy: SecurityPolicyPreset = "balanced";
  private customConfig: Partial<SecurityConfig> = {};

  /**
   * Get all available policies
   */
  getPolicies(): SecurityPolicy[] {
    return Object.values(SECURITY_POLICIES);
  }

  /**
   * Get a specific policy by name
   */
  getPolicy(preset: SecurityPolicyPreset): SecurityPolicy {
    return SECURITY_POLICIES[preset] || SECURITY_POLICIES.balanced;
  }

  /**
   * Get the current policy
   */
  getCurrentPolicy(): SecurityPolicy {
    if (this.currentPolicy === "custom") {
      return {
        ...SECURITY_POLICIES.custom,
        config: this.customConfig,
      };
    }
    return this.getPolicy(this.currentPolicy);
  }

  /**
   * Set the current policy
   */
  setPolicy(preset: SecurityPolicyPreset): void {
    this.currentPolicy = preset;
  }

  /**
   * Set custom configuration (for 'custom' preset)
   */
  setCustomConfig(config: Partial<SecurityConfig>): void {
    this.customConfig = config;
    this.currentPolicy = "custom";
  }

  /**
   * Get the current security configuration
   */
  getConfig(): SecurityConfig {
    const policy = this.getCurrentPolicy();
    return mergeSecurityConfig({
      ...policy.config,
      ...(this.currentPolicy === "custom" ? this.customConfig : {}),
    });
  }

  /**
   * Apply a policy and return the merged configuration
   */
  applyPolicy(
    preset: SecurityPolicyPreset,
    customOverrides?: Partial<SecurityConfig>,
  ): SecurityConfig {
    this.setPolicy(preset);
    if (customOverrides) {
      this.customConfig = customOverrides;
      this.currentPolicy = "custom";
    }
    return this.getConfig();
  }

  /**
   * Get policy recommendation for a use case
   */
  getRecommendation(useCase: string): SecurityPolicy {
    for (const policy of this.getPolicies()) {
      if (policy.recommendedFor.includes(useCase)) {
        return policy;
      }
    }
    return BALANCED_POLICY;
  }

  /**
   * Check if current policy allows a specific action
   */
  allowsAction(
    action: string,
    context?: { type: string; path?: string; command?: string },
  ): boolean {
    const config = this.getConfig();

    switch (action) {
      case "bash":
        if (context?.command) {
          const cmd = context.command.split(" ")[0];
          return !config.bash.blacklist.includes(cmd);
        }
        return true;

      case "file_access":
        if (context?.path) {
          for (const denied of config.paths.denied) {
            if (context.path.includes(denied.replace("*", ""))) {
              return false;
            }
          }
        }
        return true;

      case "network":
        if (context?.path) {
          for (const denied of config.network.deniedDomains) {
            if (context.path.includes(denied.replace("*", ""))) {
              return false;
            }
          }
        }
        return true;

      default:
        return true;
    }
  }

  /**
   * Get policy comparison
   */
  comparePolicies(
    policy1: SecurityPolicyPreset,
    policy2: SecurityPolicyPreset,
  ): Record<string, { policy1: unknown; policy2: unknown }> {
    const config1 = this.getPolicy(policy1).config;
    const config2 = this.getPolicy(policy2).config;

    const comparison: Record<string, { policy1: unknown; policy2: unknown }> =
      {};

    const keys = new Set([...Object.keys(config1), ...Object.keys(config2)]);
    for (const key of keys) {
      comparison[key] = {
        policy1: (config1 as any)[key],
        policy2: (config2 as any)[key],
      };
    }

    return comparison;
  }
}

/**
 * Global security policy manager instance
 */
export const globalSecurityPolicyManager = new SecurityPolicyManager();

/**
 * Create a security policy manager with custom configuration
 */
export function createSecurityPolicyManager(): SecurityPolicyManager {
  return new SecurityPolicyManager();
}

/**
 * Get a policy by name
 */
export function getSecurityPolicy(
  preset: SecurityPolicyPreset,
): SecurityPolicy {
  return globalSecurityPolicyManager.getPolicy(preset);
}

/**
 * Apply a security policy
 */
export function applySecurityPolicy(
  preset: SecurityPolicyPreset,
  customOverrides?: Partial<SecurityConfig>,
): SecurityConfig {
  return globalSecurityPolicyManager.applyPolicy(preset, customOverrides);
}
