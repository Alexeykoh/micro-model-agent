// Пресеты политик безопасности: strict/balanced/permissive + карта пресетов.
//
// Вынесено из `security-policies.ts` (правило #1: ≤300 строк/файл). Литеральные
// таблицы — в `security-policy-tables.ts`; менеджер политик остаётся в
// `security-policies.ts`.
import type { SecurityConfig } from "../../config/types";
import {
  BALANCED_AUDIT_EVENTS,
  BALANCED_BASH_BLACKLIST,
  BALANCED_CONTENT_PATTERNS,
  BALANCED_DANGEROUS_FLAGS,
  BALANCED_DANGEROUS_OPERATORS,
  BALANCED_DENIED_PATHS,
  PERMISSIVE_AUDIT_EVENTS,
  PERMISSIVE_BASH_BLACKLIST,
  PERMISSIVE_CONTENT_PATTERNS,
  PERMISSIVE_DANGEROUS_FLAGS,
  PERMISSIVE_DENIED_PATHS,
  STRICT_AUDIT_EVENTS,
  STRICT_BASH_BLACKLIST,
  STRICT_BASH_WHITELIST,
  STRICT_CONTENT_PATTERNS,
  STRICT_DANGEROUS_FLAGS,
  STRICT_DANGEROUS_OPERATORS,
  STRICT_DENIED_DOMAINS,
  STRICT_DENIED_PATHS,
} from "./security-policy-tables";

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
      blacklist: STRICT_BASH_BLACKLIST,
      whitelist: STRICT_BASH_WHITELIST,
      blockDangerousFlags: true,
      dangerousFlags: STRICT_DANGEROUS_FLAGS,
      dangerousOperators: STRICT_DANGEROUS_OPERATORS,
      logCommands: true,
    },
    paths: {
      enabled: true,
      denied: STRICT_DENIED_PATHS,
      allowed: [],
    },
    network: {
      enabled: true,
      deniedDomains: STRICT_DENIED_DOMAINS,
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
      dangerousPatterns: STRICT_CONTENT_PATTERNS,
    },
    sessionEncryption: {
      enabled: true,
      encryptHistory: true,
      encryptSessionLog: true,
    },
    auditNotifier: {
      enabled: true,
      minSeverity: "low",
      eventTypes: STRICT_AUDIT_EVENTS,
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
      blacklist: BALANCED_BASH_BLACKLIST,
      whitelist: [],
      blockDangerousFlags: true,
      dangerousFlags: BALANCED_DANGEROUS_FLAGS,
      dangerousOperators: BALANCED_DANGEROUS_OPERATORS,
      logCommands: true,
    },
    paths: {
      enabled: true,
      denied: BALANCED_DENIED_PATHS,
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
      dangerousPatterns: BALANCED_CONTENT_PATTERNS,
    },
    sessionEncryption: {
      enabled: false,
      encryptHistory: true,
      encryptSessionLog: true,
    },
    auditNotifier: {
      enabled: false,
      minSeverity: "medium",
      eventTypes: BALANCED_AUDIT_EVENTS,
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
      blacklist: PERMISSIVE_BASH_BLACKLIST,
      whitelist: [],
      blockDangerousFlags: false,
      dangerousFlags: PERMISSIVE_DANGEROUS_FLAGS,
      dangerousOperators: [],
      logCommands: true,
    },
    paths: {
      enabled: true,
      denied: PERMISSIVE_DENIED_PATHS,
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
      dangerousPatterns: PERMISSIVE_CONTENT_PATTERNS,
    },
    sessionEncryption: {
      enabled: false,
      encryptHistory: false,
      encryptSessionLog: false,
    },
    auditNotifier: {
      enabled: false,
      minSeverity: "high",
      eventTypes: PERMISSIVE_AUDIT_EVENTS,
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
