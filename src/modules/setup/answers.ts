// Модель данных first-run визарда: ответы, языки, дефолты, провайдеры для UI.
/**
 * Общая модель данных first-run визарда.
 * Едят оба фронтенда (терминальный `src/cli/setup.ts` и браузерный визард
 * `mma web`), чтобы форма и дефолты не расходились. Без терминальных/UI
 * зависимостей — безопасно импортить с веб-сервера.
 */
import type { SecurityConfig } from "../../config/types";
import type { ThemeMode, UiThemeId } from "../../config/theme-ids";
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

/** Частичные звуковые настройки визарда (`ui.sounds.*`). */
export interface SetupSoundAnswers {
  enabled?: boolean;
  done?: boolean;
  question?: boolean;
  failed?: boolean;
  volume?: number;
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
  /** Звуки уведомлений веб-UI по умолчанию (`ui.sounds.enabled`). */
  soundsEnabled?: boolean;
  /** Частичные звуковые настройки шага «Тема и уведомления». */
  sounds?: SetupSoundAnswers;
  /** `false` — не трогать провайдера, модель, контекст и итерации. */
  configureProvider?: boolean;
  /** `true` — окно контекста определяется провайдером автоматически. */
  contextAuto?: boolean;
  /** Мастер-выключатель критика (`critic.enabled`). */
  criticEnabled?: boolean;
  /** Мастер-выключатель веб-поиска (`webSearch.enabled`). */
  webSearchEnabled?: boolean;
  /** Скин веб-UI (`ui.theme`). */
  theme?: UiThemeId;
  /** Режим оформления (`ui.themeMode`). */
  themeMode?: ThemeMode;
  /** Сезонные эффекты темы (`ui.themeEffects`). */
  themeEffects?: boolean;
  /** Опционально: детали из поп-апов (только браузерный визард). */
  securityDetail?: SetupSecurityDetail;
}

/**
 * JSON-safe проекция живого security-конфига для поп-апов визарда.
 * `contentScan.dangerousPatterns` (RegExp[]) намеренно не отдаётся — оно не
 * сериализуется в JSON; UI правит только булев флаг `contentScan.enabled`.
 */
export function securityDetailFromConfig(s: SecurityConfig): SetupSecurityDetail {
  const bash = s.bash ?? ({} as SecurityConfig["bash"]);
  const paths = s.paths ?? ({} as SecurityConfig["paths"]);
  const network = s.network ?? ({} as SecurityConfig["network"]);
  return {
    bash: {
      blacklist: [...(bash.blacklist ?? [])],
      whitelist: [...(bash.whitelist ?? [])],
      logCommands: bash.logCommands ?? false,
    },
    paths: {
      denied: [...(paths.denied ?? [])],
      allowed: [...(paths.allowed ?? [])],
    },
    flags: {
      dangerousFlags: [...(bash.dangerousFlags ?? [])],
      dangerousOperators: [...(bash.dangerousOperators ?? [])],
    },
    network: {
      enabled: network.enabled ?? false,
      deniedDomains: [...(network.deniedDomains ?? [])],
      allowedDomains: [...(network.allowedDomains ?? [])],
      requestTimeout: network.requestTimeout ?? 0,
      maxResponseSize: network.maxResponseSize ?? 0,
    },
    advanced: {
      maxRecursionDepth: s.maxRecursionDepth ?? 0,
      maxFileOperations: s.maxFileOperations ?? 0,
      maxRequestsPerMinute: s.rateLimits?.maxRequestsPerMinute ?? 0,
      maxParallelTasks: s.rateLimits?.maxParallelTasks ?? 0,
      contentScanEnabled: s.contentScan?.enabled ?? false,
      sessionEncryptionEnabled: s.sessionEncryption?.enabled ?? false,
      auditNotifierEnabled: s.auditNotifier?.enabled ?? false,
      auditNotifierMinSeverity: s.auditNotifier?.minSeverity ?? "medium",
      auditNotifierEventTypes: [...(s.auditNotifier?.eventTypes ?? [])],
      auditNotifierMaxRetries: s.auditNotifier?.maxRetries ?? 3,
      auditNotifierWebhookTimeout: s.auditNotifier?.webhookTimeout ?? 5000,
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
  contextAuto: true,
} as const;

/** Провайдер на выбор в визарде (у хостед-пресетов фиксированный URL). */
export interface SetupProviderOption {
  type: string;
  label: string;
  baseUrl?: string;
  /** Провайдер не работает без API-ключа (OpenCode Zen/Go, hosted). */
  requiresKey?: boolean;
}

/** Display-пейлоад `GET /api/setup` для браузерного визарда. */
export interface SetupDisplay {
  languages: Array<{ value: string; label: string }>;
  providers: SetupProviderOption[];
  defaults: { contextWindow: number; maxToolIterations: number; contextAuto?: boolean };
}

/** Статические display-данные, общие для веб-визарда и его тестов. */
export function buildSetupDisplay(): SetupDisplay {
  const providers: SetupProviderOption[] = BUILTIN_PROVIDERS.map((spec) => {
    const option: SetupProviderOption = {
      type: spec.type,
      label: spec.label,
      requiresKey: spec.capabilities.requiresKey,
    };
    if (spec.baseUrl) option.baseUrl = spec.baseUrl;
    return option;
  });
  return {
    languages: SETUP_LANGUAGES.map((l) => ({ value: l.value, label: l.label })),
    providers,
    defaults: {
      contextWindow: SETUP_DEFAULTS.contextWindow,
      maxToolIterations: SETUP_DEFAULTS.maxToolIterations,
      contextAuto: SETUP_DEFAULTS.contextAuto,
    },
  };
}
