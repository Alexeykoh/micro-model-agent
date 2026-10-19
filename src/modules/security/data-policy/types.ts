/**
 * Контракты движка DLP `data-policy`: класс данных, находка, конфиг, целевой
 * судья и интерфейс `EgressGuard` (спека `2026-10-19-corporate-data-policy-design.md`).
 *
 * Модуль не зависит от `security.paths.enabled`/`security.network.enabled`:
 * выключение чужого флага не должно открывать утечку (INV-D2/D5).
 */

/** Класс обнаруженных данных (одна ось политики на класс). */
export type DataClass = "path" | "machine" | "env" | "secret" | "pii" | "file-content";

/** Целевое измерение egress: наружу к провайдеру или клиенту API. */
export type EgressKind = "provider" | "api";

/** Вердикт доверия к цели. `provider` — по распарсенному хосту (§6.2). */
export interface EgressTarget {
  kind: EgressKind;
  /** Для `provider`: цель доверенная (loopback/allowlist). Для `api` всегда false. */
  trusted: boolean;
  /** Распарсенный host провайдера, если применимо (диагностика/лог). */
  host?: string;
}

/** Найденный фрагмент. Позиции — по исходной строке (нормализация их не смещает). */
export interface Finding {
  dataClass: DataClass;
  /** Точный вид: `windows-abs`, `snils`, `email`, `hostname`, … */
  kind: string;
  /** Индекс начала (в код-поинтах исходной строки). */
  start: number;
  /** Индекс конца (эксклюзивный). */
  end: number;
  /** 0..1 — уверенность детектора (контекстные PII < 1). */
  confidence: number;
  /** Псевдонимизировать (tokens) vs маскировать без восстановления. */
  redact: boolean;
  /** Скрытый путь, запрещённый к отправке внешнему (`providerBlockGlobs`, D2). */
  hidden?: boolean;
}

/** Диагностика (только метаданные, без оригинала) — INV-15/§9. */
export interface GuardDiagnostic {
  module: "security.data-policy";
  operation: string;
  kind: string;
  /** `redacted` — замаскировано; `aborted` — fail-closed; `passed` — чисто. */
  outcome: "redacted" | "aborted" | "passed";
  count?: number;
  /** Причина отказа классификатора (для `aborted`/`passed`; без значений). */
  cause?: string;
}

/** Конфиг политики (`security.dataPolicy.*`). */
export interface DataPolicyConfig {
  /** Мастер-выключатель (kill-switch, R9): false — движок не вмешивается. */
  enabled: boolean;
  /** Режим путей: `prefix` — прятать корень, остаток сохранять; `full` — весь путь. */
  pathMode: "prefix" | "full";
  /** Псевдонимизация (обратимая) вместо чистой маски. */
  pseudonymize: boolean;
  /** Что применять к внешнему провайдеру. */
  egress: {
    paths: boolean;
    machine: boolean;
    env: boolean;
    pii: boolean;
    fileContent: boolean;
  };
  /** Доверенные хосты провайдера (loopback всегда доверенный). */
  trustedHosts: string[];
  /** Glob-пути, скрытые от API-клиента (→ 404). */
  apiHiddenGlobs: string[];
  /** Glob-пути, не отправляемые внешнему провайдеру (дефолт — супермножество). */
  providerBlockGlobs: string[];
  /** Уходить ли изображениями/частями к внешнему провайдеру. */
  allowImagesToExternal: boolean;
  /** Порождать fail-closed abort при ошибке классификатора (INV-D4). */
  failClosed: boolean;
  /** Порог уверенности для контекстных PII (0..1). */
  minConfidence: number;
}

/** Итог санитизации LLM-вызова. */
export interface SanitizeChatResult<M, T> {
  messages: M[];
  tools?: T[];
  /** Было ли что-то изменено (для диагностики/лога). */
  changed: boolean;
  /** Счётчики по классам (только метаданные). */
  stats: Partial<Record<DataClass, number>>;
}

/**
 * Провайдер-независимый шов DLP (спека §3.1). Инъектится в `ProviderManager`
 * (E1) и в web/service (E2). Реализация — `modules/security/data-policy`.
 */
export interface EgressGuard<M = unknown, T = unknown> {
  readonly target: EgressTarget;
  /** Санитизировать исходящий LLM-вызов: сообщения + определения тулов. */
  sanitizeChat(messages: M[], tools?: T[]): SanitizeChatResult<M, T>;
  /** Ре-гидратировать плейсхолдеры в аргументах тула (INV-D5). */
  rehydrateArgs(rawArgs: string): string;
  /** Редактировать произвольный текст/структуру для API-клиента (E2). */
  filterClient<P>(payload: P): P;
  /** Диагностика: только метаданные, без оригинала (§9). */
  readonly onDiagnostic?: (d: GuardDiagnostic) => void;
}

// Поле `SecurityConfig.dataPolicy` объявлено здесь (module augmentation), чтобы не
// растить `config/types.ts` — он на потолке гейта ≤300 (правило 6, ceilings only shrink).
declare module "../../../config/types" {
  interface SecurityConfig {
    /** Корпоративный слой DLP (спека 2026-10-19): контроль egress путей/PII. */
    dataPolicy?: DataPolicyConfig;
  }
}
