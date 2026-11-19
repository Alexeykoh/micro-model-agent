// Реестр ключей конфига для `/config` и сахарных команд: резолв, парсинг, валидация.
import type { AppConfig } from "./types";
import { EXTRA_DEFS } from "./registry-extra";
import type { ConfigEffect } from "./effects";
import { Logger } from "../logger/app-logger";
import { AGENT_DEFS } from "./registry-defs-agent";
import { META_DEFS } from "./registry-defs-meta";
import { SECURITY_DEFS } from "./registry-defs-security";
import { formatConfigValue, parseConfigValue } from "./registry-parse";
import type {
  ConfigErrorReason,
  ConfigKeyDef,
  ConfigRangeReason,
} from "./registry-key-def";

export type {
  ConfigEditorSpec,
  ConfigErrorReason,
  ConfigKeyDef,
  ConfigRangeReason,
  ConfigValueType,
} from "./registry-key-def";
export { LOCALES, LOG_LEVELS, REASONING_LEVELS, VERBOSITY_LEVELS } from "./registry-key-def";
export { formatConfigValue, parseConfigValue } from "./registry-parse";
export type { ParseResult } from "./registry-parse";

const logger = new Logger("warn", "config");

/**
 * Центральный реестр пользовательских ключей конфига для `/config` и сахарных
 * команд. Канонические ключи — буквальные пути `config.json`: что юзер видит
 * в файле, то и печатает; короткие алиасы принимаются для удобства, но второй
 * записи в дампе не создают. Модуль владеет только резолвом + парсингом +
 * валидацией; персист и `reconfigure` — дело вызывающего
 * (`repl-commands.mutateConfig`), чтобы путь записи был один.
 */

export const DEFINITIONS: ConfigKeyDef[] = [
  ...AGENT_DEFS,
  ...META_DEFS,
  ...SECURITY_DEFS,
  ...EXTRA_DEFS,
];

export const BY_NAME = new Map<string, ConfigKeyDef>();
for (const def of DEFINITIONS) {
  BY_NAME.set(def.key, def);
  for (const alias of def.aliases) BY_NAME.set(alias, def);
}

/** Резолвит ключ/алиас в деф. Нет такого — null. */
export function resolveConfigKey(name: string): ConfigKeyDef | null {
  return BY_NAME.get(name) ?? null;
}

/** Все дефы реестра (идут и в комплитер без правок). */
export function configDefs(): readonly ConfigKeyDef[] {
  return DEFINITIONS;
}

/** Все канонические ключи (для дампа), в порядке реестра. */
export function canonicalKeys(): string[] {
  return DEFINITIONS.map((d) => d.key);
}

/**
 * Ключи канонической группы по префиксу (напр. "contextBudget" → systemPrompt,
 * responseReserve). Матчит ровно `prefix.`, так что `/config contextBudget`
 * листает обе доли.
 */
export function keysForGroup(prefix: string): ConfigKeyDef[] {
  return DEFINITIONS.filter((d) => d.key.startsWith(`${prefix}.`));
}

/** Канонические + алиасные имена, для автокомплита. */
export function allConfigNames(): Array<{ name: string; def: ConfigKeyDef; alias: boolean }> {
  const out: Array<{ name: string; def: ConfigKeyDef; alias: boolean }> = [];
  for (const def of DEFINITIONS) {
    out.push({ name: def.key, def, alias: false });
    for (const a of def.aliases) out.push({ name: a, def, alias: true });
  }
  return out;
}

/** Успешное чтение ключа: ключ, деф, значение, строка для показа. */
export interface ConfigGetOk {
  ok: true;
  key: string;
  def: ConfigKeyDef;
  value: unknown;
  display: string;
}
/** Ошибка чтения: причина + ввод. */
export interface ConfigError {
  ok: false;
  reason: ConfigErrorReason;
  input: string;
}
/** Результат чтения ключа. */
export type ConfigGetResult = ConfigGetOk | ConfigError;

/** Читает ключ конфига по имени/алиасу. */
export function getConfigValue(config: AppConfig, name: string): ConfigGetResult {
  const def = resolveConfigKey(name);
  if (!def) return { ok: false, reason: "unknown-key", input: name };
  const value = def.get(config);
  return { ok: true, key: def.key, def, value, display: formatConfigValue(value) };
}

/** Успешная запись: ключ, значение, объявленные эффекты (INV-18). */
export interface ConfigSetOk {
  ok: true;
  key: string;
  def: ConfigKeyDef;
  value: unknown;
  display: string;
  /** Последствия записи — что пересобрать в живом рантайме. */
  effects: readonly ConfigEffect[];
}
/** Ошибка записи: причина + ввод + опц. ключ/деф. */
export interface ConfigSetErrorFail {
  ok: false;
  reason: ConfigErrorReason | ConfigRangeReason | "invalid";
  input: string;
  key?: string;
  def?: ConfigKeyDef;
}
/** Результат записи ключа. */
export type ConfigSetResult = ConfigSetOk | ConfigSetErrorFail;

/**
 * Кто применяет deny-list плагинов к живому реестру. Ставится из bootstrap сразу
 * после создания `PluginManager` (и переставляется на новый после `/reload`).
 *
 * Смысл шва: эффект вкл/выкл должен жить в `setConfigValue`, а не в каждой
 * поверхности отдельно — иначе `/config`, `mma plugins enable` и веб-тумблер
 * разъедутся. Конфиг при этом не знает про `modules/plugins` (нет цикла слоёв).
 */
let pluginGateApplier: ((names: string[]) => void) | null = null;

export function setPluginGateApplier(fn: ((names: string[]) => void) | null): void {
  pluginGateApplier = fn;
}

/**
 * Кто применяет память моделей провайдера (INV-19). Ставит провайдерная фаза
 * bootstrap. Слой конфига не знает про `provider.entries[]`/`provider.models` —
 * он лишь вызывает зарегистрированный апплер, как с `pluginGateApplier`.
 */
let providerMemoryApplier: ((config: AppConfig, key: string, value: unknown) => void) | null = null;

export function setProviderMemoryApplier(
  fn: ((config: AppConfig, key: string, value: unknown) => void) | null,
): void {
  providerMemoryApplier = fn;
}

function applyConfigEffects(config: AppConfig, key: string, value: unknown): void {
  try {
    providerMemoryApplier?.(config, key, value);
  } catch (e) {
    logger.warn(`provider model memory not applied: ${String(e)}`);
  }
  if (key !== "plugins.disabled" || !pluginGateApplier) return;
  const names = Array.isArray(value) ? value.map((v) => String(v)) : [];
  try {
    pluginGateApplier(names);
  } catch (e) {
    logger.warn(`plugins.disabled not applied: ${String(e)}`);
  }
}

/** Пишет ключ: резолв → парсинг → валидация → set + эффекты ключа. */
export function setConfigValue(config: AppConfig, name: string, raw: string): ConfigSetResult {
  const def = resolveConfigKey(name);
  if (!def) return { ok: false, reason: "unknown-key", input: name };
  if (def.readOnly) return { ok: false, reason: "read-only", input: name, key: def.key, def };

  const parsed = parseConfigValue(def, raw);
  if (!parsed.ok) return { ok: false, reason: "invalid-value", input: name, key: def.key, def };

  const extra = def.extraValidate?.(config, parsed.value);
  if (extra) return { ok: false, reason: extra, input: name, key: def.key, def };

  def.set!(config, parsed.value);
  applyConfigEffects(config, def.key, parsed.value);
  return {
    ok: true,
    key: def.key,
    def,
    value: parsed.value,
    display: formatConfigValue(parsed.value),
    effects: def.effects,
  };
}

/** Проверка известности ключа (для подсказок). */
export function isKnownConfigKey(name: string): boolean {
  return BY_NAME.has(name);
}

/**
 * Снимает текущие значения всех канонических ключей. На старте REPL — "boot-снапшот",
 * чтобы `/config reset` откатывал изменения сессии (а не прыгал к дефолтам схемы,
 * неоднозначным для полей вида `provider.active`).
 */
export function captureConfigSnapshot(config: AppConfig): Map<string, unknown> {
  const snapshot = new Map<string, unknown>();
  for (const def of DEFINITIONS) {
    try {
      snapshot.set(def.key, structuredClone(def.get(config)));
    } catch {
      // Частичные/мок-конфиги (тесты) могут не иметь поля — скипаем его, а не весь
      // снапшот. Реальные конфиги полны.
    }
  }
  return snapshot;
}
