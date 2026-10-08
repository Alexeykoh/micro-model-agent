// Реестр ключей конфига для `/config` и сахарных команд: резолв, парсинг, валидация.
import type { AppConfig, ReasoningMode } from "./types";
import { DEFAULTS } from "./defaults";
import { DEFAULT_SECURITY_CONFIG } from "./security";
import { setBudgetShare, type BudgetShareKey } from "./budget";
import { readMmaVersion } from "../core/version";
import { EXTRA_DEFS } from "./registry-extra";
import { Logger } from "../logger/app-logger";

const logger = new Logger("warn", "config");

/**
 * Центральный реестр пользовательских ключей конфига для `/config` и сахарных
 * команд. Канонические ключи — буквальные пути `config.json`: что юзер видит
 * в файле, то и печатает; короткие алиасы принимаются для удобства, но второй
 * записи в дампе не создают. Модуль владеет только резолвом + парсингом +
 * валидацией; персист и `reconfigure` — дело вызывающего
 * (`repl-commands.mutateConfig`), чтобы путь записи был один.
 */

/** Тип значения ключа конфига. */
export type ConfigValueType = "string" | "int" | "share" | "bool" | "enum" | "json" | "list";

/** Допустимые уровни reasoning. */
export const REASONING_LEVELS = [
  "auto",
  "default",
  "none",
  "low",
  "medium",
  "high",
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

/**
 * Как GUI должен редактировать ключ `list`/`json`. Реестр остаётся единственным
 * источником правды о ТОМ, что хранит ключ; здесь лишь подсказка показа
 * (строка через запятую годится для `tools.defaultTags`, но неверна для
 * regex с запятыми). Без значения — plain-input (list) или JSON-textarea (json).
 */
export interface ConfigEditorSpec {
  /**
   * `tags` — чипсы строк; `checkboxes` — мультивыбор; `table` — строки записей;
   * `select` — выпадающий список, наполняемый из живого источника
   * (`optionsSource`), а не из статического `enumValues`.
   */
  kind: "tags" | "checkboxes" | "table" | "select";
  /** Живой источник опций для `select` (модели/провайдеры из `/api`). */
  optionsSource?: "models" | "providers";
  /** Допустимые значения для `checkboxes`. */
  options?: readonly string[];
  /** Колонки для `table`. Первая колонка — ключ записи. */
  columns?: ReadonlyArray<{
    key: string;
    /** `number` — числовой инпут, `bool` — чекбокс. Дефолт: текст. */
    type?: "string" | "number" | "bool";
    optional?: boolean;
    /** Текстовая колонка со значением-списком (правится через запятую). */
    array?: boolean;
    /** Колонка-`select`, наполняемая из живого источника опций. */
    optionsSource?: "models" | "providers";
  }>;
  /** Свободный хинт в добавлялке строк (напр. пример regex). */
  placeholder?: string;
}

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
  reconfigure: boolean;
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

const MIN_SHARE = 0.05;
const MAX_SHARE = 0.9;
const MAX_COMBINED = 0.95;

function shareField(key: BudgetShareKey, canonical: string): ConfigKeyDef {
  const field = key === "system" ? "systemPrompt" : "responseReserve";
  const other = key === "system" ? "responseReserve" : "systemPrompt";
  return {
    key: canonical,
    aliases: [`context.${key}`],
    domain: "budget",
    valueType: "share",
    min: MIN_SHARE,
    max: MAX_SHARE,
    step: 0.01,
    reconfigure: true,
    get: (c) => c.contextBudget[field],
    set: (c, v) => setBudgetShare(c, key, v as number),
    extraValidate: (c, v) => {
      const n = v as number;
      const total = n + c.contextBudget[other];
      return total > MAX_COMBINED ? "combined" : null;
    },
  };
}

/** Верхнеуровневые + вложенные тумблеры безопасности, все читаются тулами живьём. */
type SecurityToggle = "enabled" | "bash" | "paths" | "contentScan" | "sessionEncryption" | "network";

function securityToggle(field: SecurityToggle, canonical: string): ConfigKeyDef {
  return {
    key: canonical,
    aliases: [],
    domain: "security",
    valueType: "bool",
    // Тулы читают `config.security` живьём; пересборка агента не нужна. Шифрование
    // сессии снапшотится в стор на bootstrap, так что полный эффект — только со
    // следующего запуска: reconfigure его всё равно не пересобрал бы.
    reconfigure: false,
    get: (c) => {
      const sec = c.security;
      if (!sec) return false;
      return field === "enabled" ? sec.enabled : sec[field].enabled;
    },
    set: (c, v) => {
      if (!c.security) c.security = structuredClone(DEFAULT_SECURITY_CONFIG);
      if (field === "enabled") c.security.enabled = v as boolean;
      else c.security[field].enabled = v as boolean;
    },
  };
}

const DEFINITIONS: ConfigKeyDef[] = [
  {
    key: "model",
    aliases: [],
    domain: "agent",
    valueType: "string",
    reconfigure: true,
    get: (c) => c.model,
    set: (c, v) => {
      c.model = String(v);
    },
  },
  {
    key: "provider.active",
    aliases: [],
    domain: "provider",
    valueType: "string",
    reconfigure: true,
    get: (c) => c.provider.active ?? c.provider.type,
    set: (c, v) => {
      c.provider.active = String(v);
    },
    extraValidate: (c, v) => {
      const entries = c.provider.entries ?? [];
      if (entries.length === 0) return null;
      const name = String(v);
      const found = entries.some((e) => e.label === name || e.type === name);
      return found ? null : "invalid";
    },
  },
  {
    key: "contextWindow",
    aliases: ["context.window"],
    domain: "budget",
    valueType: "int",
    min: 1024,
    step: 1024,
    reconfigure: true,
    get: (c) => c.contextWindow,
    set: (c, v) => {
      c.contextWindow = v as number;
      // Ручное окно = осознанный выбор: проба провайдера больше не перетирает
      // его (boot / смена модели). Обратно — только явный `/config contextAuto true`.
      c.contextAuto = false;
    },
  },
  shareField("system", "contextBudget.systemPrompt"),
  shareField("reserve", "contextBudget.responseReserve"),
  {
    key: "showReasoning",
    aliases: ["reasoning.show"],
    domain: "reasoning",
    valueType: "bool",
    reconfigure: false,
    get: (c) => c.showReasoning,
    set: (c, v) => {
      c.showReasoning = v as boolean;
    },
  },
  {
    key: "reasoning.mode",
    aliases: ["reasoning.level"],
    domain: "reasoning",
    valueType: "enum",
    enumValues: REASONING_LEVELS,
    reconfigure: true,
    get: (c) => c.reasoning?.mode ?? "auto",
    set: (c, v) => {
      const base = c.reasoning ?? structuredClone(DEFAULTS.reasoning!);
      c.reasoning = { ...base, mode: v as ReasoningMode };
    },
  },
  {
    key: "ui.verbosity",
    aliases: ["verbosity"],
    domain: "ui",
    valueType: "enum",
    enumValues: VERBOSITY_LEVELS,
    reconfigure: false,
    get: (c) => c.ui.verbosity ?? (c.ui.verbose ? "verbose" : "quiet"),
    set: (c, v) => {
      c.ui.verbosity = v as "quiet" | "normal" | "verbose";
    },
  },
  {
    key: "maxToolIterations",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 1,
    step: 1,
    reconfigure: false,
    get: (c) => c.maxToolIterations,
    set: (c, v) => {
      c.maxToolIterations = v as number;
    },
  },
  {
    key: "stuckThreshold",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 1,
    step: 1,
    reconfigure: false,
    get: (c) => c.stuckThreshold,
    set: (c, v) => {
      c.stuckThreshold = v as number;
    },
  },
  {
    key: "moe.enabled",
    aliases: [],
    domain: "agent",
    valueType: "bool",
    reconfigure: true,
    get: (c) => c.moe?.enabled ?? DEFAULTS.moe.enabled,
    set: (c, v) => {
      c.moe = { ...(c.moe ?? DEFAULTS.moe), enabled: v as boolean };
    },
  },
  {
    key: "moe.maxReplanCycles",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 0,
    max: 10,
    step: 1,
    reconfigure: true,
    get: (c) => c.moe?.maxReplanCycles ?? DEFAULTS.moe.maxReplanCycles,
    set: (c, v) => {
      c.moe = { ...(c.moe ?? DEFAULTS.moe), maxReplanCycles: v as number };
    },
  },
  {
    key: "critic.enabled",
    aliases: [],
    domain: "agent",
    valueType: "bool",
    reconfigure: true,
    get: (c) => c.critic?.enabled ?? DEFAULTS.critic.enabled,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), enabled: v as boolean };
    },
  },
  {
    key: "critic.maxCalls",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 0,
    max: 20,
    step: 1,
    reconfigure: true,
    get: (c) => c.critic?.maxCalls ?? DEFAULTS.critic.maxCalls,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), maxCalls: v as number };
    },
  },
  {
    key: "critic.maxRepairCycles",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 0,
    max: 5,
    step: 1,
    reconfigure: true,
    get: (c) => c.critic?.maxRepairCycles ?? DEFAULTS.critic.maxRepairCycles,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), maxRepairCycles: v as number };
    },
  },
  {
    key: "critic.timeoutMs",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 1000,
    max: 120000,
    step: 1000,
    reconfigure: true,
    get: (c) => c.critic?.timeoutMs ?? DEFAULTS.critic.timeoutMs,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), timeoutMs: v as number };
    },
  },
  {
    key: "critic.model",
    aliases: [],
    domain: "agent",
    valueType: "string",
    reconfigure: true,
    allowEmpty: true,
    editor: { kind: "select", optionsSource: "models" },
    get: (c) => c.critic?.model ?? "",
    set: (c, v) => {
      const s = String(v).trim();
      c.critic = { ...(c.critic ?? DEFAULTS.critic), model: s ? s : undefined };
    },
  },
  {
    key: "critic.tools",
    aliases: [],
    domain: "agent",
    valueType: "bool",
    reconfigure: true,
    get: (c) => c.critic?.tools ?? DEFAULTS.critic.tools,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), tools: v as boolean };
    },
  },
  {
    key: "critic.provider",
    aliases: [],
    domain: "agent",
    valueType: "string",
    reconfigure: true,
    allowEmpty: true,
    editor: { kind: "select", optionsSource: "providers" },
    get: (c) => {
      const p = c.critic?.provider;
      if (!p) return "";
      if (typeof p === "string") return p;
      return p.active ?? p.type ?? "";
    },
    set: (c, v) => {
      const s = String(v).trim();
      c.critic = {
        ...(c.critic ?? DEFAULTS.critic),
        provider: s ? s : undefined,
      };
    },
    extraValidate: (c, v) => {
      const s = String(v).trim();
      if (!s) return null;
      const entries = c.provider.entries ?? [];
      if (entries.length === 0) return null;
      const found = entries.some((e) => (e.label || e.type) === s || e.type === s);
      return found ? null : "invalid";
    },
  },
  {
    key: "logLevel",
    aliases: [],
    domain: "agent",
    valueType: "enum",
    enumValues: LOG_LEVELS,
    reconfigure: false,
    get: (c) => c.logLevel,
    set: (c, v) => {
      c.logLevel = String(v);
    },
  },
  {
    key: "locale",
    aliases: [],
    domain: "i18n",
    valueType: "enum",
    enumValues: LOCALES,
    reconfigure: false,
    get: (c) => c.locale,
    set: (c, v) => {
      c.locale = String(v);
    },
  },
  {
    key: "version",
    aliases: [],
    domain: "agent",
    valueType: "string",
    reconfigure: false,
    readOnly: true,
    // Версия *установленного пакета*, а не `config.version` (то — версия схемы
    // конфига для детекта миграций, с релизом не совпадает никогда). Читается
    // в момент вызова, так что следует за обновлениями без рестарта.
    get: () => readMmaVersion(),
  },
  securityToggle("enabled", "security.enabled"),
  securityToggle("bash", "security.bash.enabled"),
  {
    key: "security.bash.blockDangerousFlags",
    aliases: [],
    domain: "security",
    valueType: "bool",
    reconfigure: false,
    get: (c) => c.security?.bash.blockDangerousFlags ?? true,
    set: (c, v) => {
      if (!c.security) c.security = structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.bash.blockDangerousFlags = v as boolean;
    },
  },
  securityToggle("paths", "security.paths.enabled"),
  securityToggle("contentScan", "security.contentScan.enabled"),
  securityToggle("sessionEncryption", "security.sessionEncryption.enabled"),
  securityToggle("network", "security.network.enabled"),
  ...EXTRA_DEFS,
];

const BY_NAME = new Map<string, ConfigKeyDef>();
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

/** Человекочитаемое форматирование значения (bool → on/off, массивы через запятую). */
export function formatConfigValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Результат парсинга сырого значения: ок или "invalid". */
export type ParseResult = { ok: true; value: unknown } | { ok: false; reason: "invalid" };

function parseBool(raw: string): ParseResult {
  const v = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes", "y", "enable", "enabled"].includes(v)) return { ok: true, value: true };
  if (["off", "false", "0", "no", "n", "disable", "disabled"].includes(v)) return { ok: true, value: false };
  return { ok: false, reason: "invalid" };
}

/** Парсит сырую строку по типу ключа (bool/enum/int/share/list/json). */
export function parseConfigValue(def: ConfigKeyDef, raw: string): ParseResult {
  const trimmed = raw.trim();
  switch (def.valueType) {
    case "string":
      if (trimmed.length === 0) {
        return def.allowEmpty ? { ok: true, value: "" } : { ok: false, reason: "invalid" };
      }
      return { ok: true, value: trimmed };
    case "bool":
      return parseBool(trimmed);
    case "enum": {
      const v = trimmed.toLowerCase();
      if (def.enumValues && !def.enumValues.includes(v)) return { ok: false, reason: "invalid" };
      return { ok: true, value: v };
    }
    case "int": {
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, reason: "invalid" };
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, reason: "invalid" };
      if (def.min !== undefined && n < def.min) return { ok: false, reason: "invalid" };
      if (def.max !== undefined && n > def.max) return { ok: false, reason: "invalid" };
      return { ok: true, value: n };
    }
    case "share": {
      // Доля (0.1) или проценты (10%).
      const isPct = trimmed.endsWith("%");
      const body = isPct ? trimmed.slice(0, -1).trim() : trimmed;
      if (!/^-?\d+(\.\d+)?$/.test(body)) return { ok: false, reason: "invalid" };
      let n = Number(body);
      if (isPct) n = n / 100;
      if (!Number.isFinite(n) || n < MIN_SHARE || n > MAX_SHARE) return { ok: false, reason: "invalid" };
      return { ok: true, value: n };
    }
    case "list": {
      if (trimmed.length === 0) return { ok: true, value: [] };
      // Структурные редакторы постят JSON-массив (значения могут содержать запятые,
      // напр. regex вида `a{1,3}`); REPL держит синтаксис через запятую.
      if (trimmed.startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
            return { ok: true, value: parsed };
          }
        } catch {
          /* fall through to comma splitting */
        }
      }
      const items = trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      return { ok: true, value: items };
    }
    case "json": {
      if (trimmed.length > 20000) return { ok: false, reason: "invalid" };
      try {
        return { ok: true, value: JSON.parse(trimmed) };
      } catch {
        return { ok: false, reason: "invalid" };
      }
    }
  }
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

/** Успешная запись: ключ, значение, нужен ли reconfigure. */
export interface ConfigSetOk {
  ok: true;
  key: string;
  def: ConfigKeyDef;
  value: unknown;
  display: string;
  reconfigure: boolean;
  /** Key needs an agent-level reasoning side effect after apply. */
  reasoningChanged: boolean;
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
 * Держит `provider.models` (последняя модель каждого провайдера) в синхроне. Запись
 * `model` запоминается под активным провайдером; смена `provider.active`
 * восстанавливает запомненную модель провайдера, чтобы свитч молча не оставлял
 * модель, которую новый бэкенд не обслуживает. Заодно зеркалит легаси-плоские
 * поля (`type`/`baseUrl`/`apiKey`) из активной записи — иначе они протухают
 * после hot-swap, а баннер и внеполосные читатели плоских полей врут.
 */
/**
 * Зеркалит легаси-плоские поля (`type`/`baseUrl`/`apiKey`) из активной записи:
 * после hot-swap `/provider use` они протухают, а баннер и внеполосные читатели
 * плоских полей врут.
 */
function mirrorActiveEntryFields(
  provider: AppConfig["provider"],
  activeName: string,
): void {
  const entry = (provider.entries ?? []).find(
    (e) => e.label === activeName || e.type === activeName,
  );
  if (!entry) return;
  provider.type = entry.type;
  provider.baseUrl = entry.baseUrl;
  provider.apiKey = entry.apiKey;
}

function applyProviderModelMemory(config: AppConfig, key: string, value: unknown): void {
  const provider = config.provider;
  const activeName = provider.active ?? provider.type;
  if (key === "model") {
    if (!activeName) return;
    provider.models = { ...(provider.models ?? {}), [activeName]: String(value) };
    return;
  }
  if (key === "provider.active") {
    const remembered = provider.models?.[String(value)];
    if (remembered) config.model = remembered;
    mirrorActiveEntryFields(provider, String(value));
  }
}

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

function applyConfigEffects(config: AppConfig, key: string, value: unknown): void {
  applyProviderModelMemory(config, key, value);
  if (key !== "plugins.disabled" || !pluginGateApplier) return;
  const names = Array.isArray(value) ? value.map((v) => String(v)) : [];
  try {
    pluginGateApplier(names);
  } catch (e) {
    logger.warn(`plugins.disabled not applied: ${String(e)}`);
  }
}

/** Пишет ключ: резолв → парсинг → валидация → set + память моделей провайдера. */
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
    reconfigure: def.reconfigure,
    reasoningChanged: def.key === "reasoning.mode",
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
