// Модель данных first-run визарда: ответы, языки, дефолты, провайдеры для UI.
/**
 * Общая модель данных first-run визарда.
 * Едят оба фронтенда (терминальный `src/cli/setup.ts` и браузерный визард
 * `mma web`), чтобы форма и дефолты не расходились. Без терминальных/UI
 * зависимостей — безопасно импортить с веб-сервера.
 */
import type { SecurityConfig } from "../../config/types";
import { BUILTIN_PROVIDERS } from "../providers/presets";

/** Тонкая настройка безопасности из поп-апов шага «Безопасность» (JSON-safe). */
export interface SetupSecurityDetail {
  bash?: {
    blacklist?: string[];
    whitelist?: string[];
    logCommands?: boolean;
  };
  paths?: {
    denied?: string[];
    allowed?: string[];
  };
  flags?: {
    dangerousFlags?: string[];
    dangerousOperators?: string[];
  };
  network?: {
    enabled?: boolean;
    deniedDomains?: string[];
    allowedDomains?: string[];
    requestTimeout?: number;
    maxResponseSize?: number;
  };
  advanced?: {
    maxRecursionDepth?: number;
    maxFileOperations?: number;
    maxRequestsPerMinute?: number;
    maxParallelTasks?: number;
    contentScanEnabled?: boolean;
    sessionEncryptionEnabled?: boolean;
    auditNotifierEnabled?: boolean;
    auditNotifierMinSeverity?: "low" | "medium" | "high" | "critical";
    auditNotifierEventTypes?: string[];
    auditNotifierMaxRetries?: number;
    auditNotifierWebhookTimeout?: number;
  };
}

/** Все, что собирает first-run визард и пишет `applyAnswersToConfig`. */
export interface SetupAnswers {
  provider: string;
  apiBase: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxToolIterations: number;
  locale: string;
  securityBashBlock: boolean;
  securityFlagsBlock: boolean;
  securityPathsRestrict: boolean;
  /** Опционально: детали из поп-апов (только браузерный визард). */
  securityDetail?: SetupSecurityDetail;
}

/**
 * JSON-safe проекция живого security-конфига для поп-апов визарда.
 * `contentScan.dangerousPatterns` (RegExp[]) намеренно не отдаётся — оно не
 * сериализуется в JSON; UI правит только булев флаг `contentScan.enabled`.
 */
export function securityDetailFromConfig(s: SecurityConfig): SetupSecurityDetail {
  return {
    bash: {
      blacklist: [...s.bash.blacklist],
      whitelist: [...s.bash.whitelist],
      logCommands: s.bash.logCommands,
    },
    paths: { denied: [...s.paths.denied], allowed: [...s.paths.allowed] },
    flags: {
      dangerousFlags: [...s.bash.dangerousFlags],
      dangerousOperators: [...s.bash.dangerousOperators],
    },
    network: {
      enabled: s.network.enabled,
      deniedDomains: [...s.network.deniedDomains],
      allowedDomains: [...s.network.allowedDomains],
      requestTimeout: s.network.requestTimeout,
      maxResponseSize: s.network.maxResponseSize,
    },
    advanced: {
      maxRecursionDepth: s.maxRecursionDepth,
      maxFileOperations: s.maxFileOperations,
      maxRequestsPerMinute: s.rateLimits.maxRequestsPerMinute,
      maxParallelTasks: s.rateLimits.maxParallelTasks,
      contentScanEnabled: s.contentScan.enabled,
      sessionEncryptionEnabled: s.sessionEncryption.enabled,
      auditNotifierEnabled: s.auditNotifier.enabled,
      auditNotifierMinSeverity: s.auditNotifier.minSeverity ?? "medium",
      auditNotifierEventTypes: [...(s.auditNotifier.eventTypes ?? [])],
      auditNotifierMaxRetries: s.auditNotifier.maxRetries ?? 3,
      auditNotifierWebhookTimeout: s.auditNotifier.webhookTimeout ?? 5000,
    },
  };
}

/** Языки UI визарда (подписи — на своём языке). */
export const SETUP_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
] as const;

/** Числовые дефолты шага настроек агента. */
export const SETUP_DEFAULTS = {
  contextWindow: 32768,
  maxToolIterations: 200,
} as const;

/** Провайдер на выбор в визарде (у хостед-пресетов фиксированный URL). */
export interface SetupProviderOption {
  type: string;
  label: string;
  baseUrl?: string;
}

/** Display-пейлоад `GET /api/setup` для браузерного визарда. */
export interface SetupDisplay {
  languages: Array<{ value: string; label: string }>;
  providers: SetupProviderOption[];
  defaults: { contextWindow: number; maxToolIterations: number };
}

/** Статические display-данные, общие для веб-визарда и его тестов. */
export function buildSetupDisplay(): SetupDisplay {
  const providers: SetupProviderOption[] = BUILTIN_PROVIDERS.map((spec) => {
    const option: SetupProviderOption = { type: spec.type, label: spec.label };
    if (spec.baseUrl) option.baseUrl = spec.baseUrl;
    return option;
  });
  return {
    languages: SETUP_LANGUAGES.map((l) => ({ value: l.value, label: l.label })),
    providers,
    defaults: {
      contextWindow: SETUP_DEFAULTS.contextWindow,
      maxToolIterations: SETUP_DEFAULTS.maxToolIterations,
    },
  };
}
