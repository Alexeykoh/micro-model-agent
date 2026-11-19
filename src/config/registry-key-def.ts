// Форма ключа реестра конфига: тип значения, границы долей, домен/эффекты.
import type { AppConfig } from "./types";
import type { ConfigEffect } from "./effects";
import type { ConfigEditorSpec } from "./editor-spec";

/** Тип значения ключа конфига. */
export type ConfigValueType = "string" | "int" | "share" | "bool" | "enum" | "json" | "list";

/** Допустимые уровни reasoning. */
export const REASONING_LEVELS = [
  "auto",
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Допустимые уровни лога. */
export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;

/** Допустимые уровни болтливости. */
export const VERBOSITY_LEVELS = ["quiet", "normal", "verbose"] as const;

/** Допустимые локали. */
export const LOCALES = ["en", "ru"] as const;

/** Причина ошибки конфига: неизвестный ключ / read-only / плохое значение. */
export type ConfigErrorReason = "unknown-key" | "read-only" | "invalid-value";
/** Причина отказа доли бюджета: вне диапазона / сумма переполнена. */
export type ConfigRangeReason = "range" | "combined";

export type { ConfigEditorSpec } from "./editor-spec";

export interface ConfigKeyDef {
  /** Канонический ключ — буквальный путь config.json. */
  key: string;
  aliases: string[];
  domain: string;
  valueType: ConfigValueType;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  /** Шаг для числовых UI (напр. токены шагом 1024). */
  step?: number;
  /**
   * Эффекты записи ключа (INV-18): что пересобрать в живом рантайме. Пусто —
   * значение читается тулами напрямую, менять нечего.
   */
  effects: readonly ConfigEffect[];
  readOnly?: boolean;
  /**
   * Разрешает пустое значение для `string` (пустая строка → сброс в undefined
   * через `set`). Нужно необязательным ссылкам (модель/провайдер), где пустой
   * выбор UI означает «использовать активное».
   */
  allowEmpty?: boolean;
  /** GUI-хинт рендера значений `list`/`json` (см. {@link ConfigEditorSpec}). */
  editor?: ConfigEditorSpec;
  get(config: AppConfig): unknown;
  set?(config: AppConfig, value: unknown): void;
  /** Доп. валидация сверх типа/диапазона (напр. существование записи провайдера). */
  extraValidate?(config: AppConfig, value: unknown): ConfigRangeReason | "invalid" | null;
}

export const MIN_SHARE = 0.05;
export const MAX_SHARE = 0.9;
export const MAX_COMBINED = 0.95;
