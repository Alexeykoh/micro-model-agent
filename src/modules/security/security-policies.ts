// Пресеты политик безопасности: strict/balanced/permissive + менеджер политик.
import type { SecurityConfig } from "../../config/types";
import { mergeSecurityConfig } from "../../config/security";
import {
  BASE_BLACKLIST,
  DANGEROUS_COMMANDS,
  PERMISSIVE_BLACKLIST,
  STRICT_EXTRA_BLACKLIST,
} from "./security-lists";

/** Пресеты политик безопасности. */
export type SecurityPolicyPreset = "strict" | "balanced" | "permissive" | "custom";

/** Определение политики безопасности. */
export interface SecurityPolicy {
  /** Имя политики */
  name: string;
  /** Описание политики */
  description: string;
  /** Тип пресета */
  preset: SecurityPolicyPreset;
  /** Security-конфиг политики */
  config: Partial<SecurityConfig>;
  /** Рекомендуемые кейсы */
  recommendedFor: string[];
}

/**
 * Strict: максимум безопасности, минимум гибкости.
 * Для: продакшн, чувствительные данные, многопользовательские системы.
 */
export const STRICT_POLICY: SecurityPolicy = {
  name: "Strict",
  description: "Maximum security with minimal flexibility. Blocks most dangerous operations.",
  preset: "strict",
  recommendedFor: ["production", "sensitive-data", "multi-user", "enterprise"],
  config: {
    enabled: true,
    bash: {
      enabled: true,
      blacklist: [
        ...BASE_BLACKLIST,
        ...STRICT_EXTRA_BLACKLIST,
        ...DANGEROUS_COMMANDS,
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
      dangerousOperators: [">", ">>", "2>", "2>>", "|", "&&", "||", ";", "&", "`", "$("],
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
        /for\(;;\)/,
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
 * Balanced: вменяемая безопасность с разумной гибкостью.
 * Для: разработка, однопользовательские системы, общее использование.
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
      blacklist: [...BASE_BLACKLIST, ...DANGEROUS_COMMANDS],
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
        /for\(;;\)/,
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
      eventTypes: ["security_block", "bash_command", "file_operation", "network_request"],
      maxRetries: 3,
    },
  },
};

/**
 * Permissive: минимум безопасности, максимум гибкости.
 * Для: доверенные окружения, локальная разработка, тесты.
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
      blacklist: [...PERMISSIVE_BLACKLIST, ...DANGEROUS_COMMANDS],
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
        /for\(;;\)/,
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

/** Все доступные политики безопасности. */
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

/** Менеджер политик безопасности (текущая + кастом). */
export class SecurityPolicyManager {
  private currentPolicy: SecurityPolicyPreset = "balanced";
  private customConfig: Partial<SecurityConfig> = {};

  /** Все доступные политики. */
  getPolicies(): SecurityPolicy[] {
    return Object.values(SECURITY_POLICIES);
  }

  /** Политика по имени (неизвестная — balanced). */
  getPolicy(preset: SecurityPolicyPreset): SecurityPolicy {
    return SECURITY_POLICIES[preset] || SECURITY_POLICIES.balanced;
  }

  /** Текущая политика (custom — с кастомным конфигом). */
  getCurrentPolicy(): SecurityPolicy {
    if (this.currentPolicy === "custom") {
      return {
        ...SECURITY_POLICIES.custom,
        config: this.customConfig,
      };
    }
    return this.getPolicy(this.currentPolicy);
  }

  /** Назначить текущую политику. */
  setPolicy(preset: SecurityPolicyPreset): void {
    this.currentPolicy = preset;
  }

  /** Задать кастомный конфиг (переключает на 'custom'). */
  setCustomConfig(config: Partial<SecurityConfig>): void {
    this.customConfig = config;
    this.currentPolicy = "custom";
  }

  /** Текущий security-конфиг (политика + мерж дефолтов). */
  getConfig(): SecurityConfig {
    const policy = this.getCurrentPolicy();
    return mergeSecurityConfig({
      ...policy.config,
      ...(this.currentPolicy === "custom" ? this.customConfig : {}),
    });
  }

  /** Применить политику с опциональными оверрайдами; вернуть смерженный конфиг. */
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

  /** Рекомендованная политика для кейса (иначе — balanced). */
  getRecommendation(useCase: string): SecurityPolicy {
    for (const policy of this.getPolicies()) {
      if (policy.recommendedFor.includes(useCase)) {
        return policy;
      }
    }
    return BALANCED_POLICY;
  }

  /** Разрешает ли текущая политика действие (bash/file_access/network). */
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

  /** Посравнить две политики по ключам конфига. */
  comparePolicies(
    policy1: SecurityPolicyPreset,
    policy2: SecurityPolicyPreset,
  ): Record<string, { policy1: unknown; policy2: unknown }> {
    const config1 = this.getPolicy(policy1).config;
    const config2 = this.getPolicy(policy2).config;

    const comparison: Record<string, { policy1: unknown; policy2: unknown }> = {};

    const keys = new Set([...Object.keys(config1), ...Object.keys(config2)]);
    for (const key of keys) {
      comparison[key] = {
        policy1: config1[key as keyof SecurityConfig],
        policy2: config2[key as keyof SecurityConfig],
      };
    }

    return comparison;
  }
}

/** Глобальный менеджер политик. */
export const globalSecurityPolicyManager = new SecurityPolicyManager();

/** Создать менеджер политик. */
export function createSecurityPolicyManager(): SecurityPolicyManager {
  return new SecurityPolicyManager();
}

/** Политика по имени через глобальный менеджер. */
export function getSecurityPolicy(preset: SecurityPolicyPreset): SecurityPolicy {
  return globalSecurityPolicyManager.getPolicy(preset);
}

/** Применить политику через глобальный менеджер. */
export function applySecurityPolicy(
  preset: SecurityPolicyPreset,
  customOverrides?: Partial<SecurityConfig>,
): SecurityConfig {
  return globalSecurityPolicyManager.applyPolicy(preset, customOverrides);
}
