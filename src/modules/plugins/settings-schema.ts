// Валидация манифеста настроек плагина и значений по нему. Чистые функции
// без файловой системы: стор (`settings-store.ts`) и REST поверх них.
// Невалидная схема/значение никогда не бросает — возвращает замечания.
import type { PluginSettingDef } from "../types";

const KEY_RE = /^[a-z0-9_]{1,64}$/;

/** Схема после санитизации: только валидные дефы, дубли убраны. */
export interface SanitizedSchema {
  defs: PluginSettingDef[];
  warnings: string[];
}

/** Проверяет один деф; null — деф годен. */
function checkDef(def: PluginSettingDef, seen: Set<string>): string | null {
  if (!def || typeof def !== "object") return "setting def is not an object";
  if (typeof def.key !== "string" || !KEY_RE.test(def.key)) {
    return `invalid setting key ${JSON.stringify((def as { key?: unknown }).key)}`;
  }
  if (seen.has(def.key)) return `duplicate setting key "${def.key}"`;
  const types = ["string", "number", "boolean", "enum", "list", "json"];
  if (!types.includes(def.type)) return `setting "${def.key}" has unknown type`;
  if (def.type === "enum") {
    if (!Array.isArray(def.enum) || def.enum.length === 0) {
      return `setting "${def.key}" needs a non-empty enum list`;
    }
    if (!def.enum.every((v) => typeof v === "string")) {
      return `setting "${def.key}" enum values must be strings`;
    }
  }
  if (def.default !== undefined) {
    const problem = checkValue(def, def.default);
    if (problem) return `setting "${def.key}" default invalid: ${problem}`;
  }
  return null;
}

/**
 * Проверяет манифест: не массив → пустая схема; битые дефы отбрасываются
 * с warning (регистрация плагина не страдает).
 */
export function validateSettingsSchema(schema: unknown): SanitizedSchema {
  if (schema === undefined || schema === null) return { defs: [], warnings: [] };
  if (!Array.isArray(schema)) {
    return { defs: [], warnings: ["settingsSchema is not an array"] };
  }
  const defs: PluginSettingDef[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const raw of schema) {
    const problem = checkDef(raw as PluginSettingDef, seen);
    if (problem) {
      warnings.push(problem);
      continue;
    }
    const def = raw as PluginSettingDef;
    seen.add(def.key);
    defs.push(def);
  }
  return { defs, warnings };
}

/** Проверка значения по дефу; null — годно. */
export function checkValue(def: PluginSettingDef, value: unknown): string | null {
  switch (def.type) {
    case "string":
      return typeof value === "string" ? null : "expected string";
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected number";
      if (def.min !== undefined && value < def.min) return `below min ${def.min}`;
      if (def.max !== undefined && value > def.max) return `above max ${def.max}`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "expected boolean";
    case "enum":
      return typeof value === "string" && (def.enum ?? []).includes(value)
        ? null
        : `expected one of ${(def.enum ?? []).join(", ")}`;
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? null
        : "expected string array";
    case "json":
      // JSON-тип принимает любое JSON-сериализуемое значение.
      return value === undefined ? "expected value" : null;
  }
}

/**
 * Мягкое приведение сырого значения к типу дефа (числа из строк формы,
 * `"true"/"false"`, CSV → list). Возвращает исходное, если не приводится, —
 * тогда `checkValue` честно забракует.
 */
export function coerceValue(def: PluginSettingDef, raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;
  switch (def.type) {
    case "number": {
      if (typeof raw === "number") return raw;
      if (typeof raw === "string" && raw.trim() !== "") {
        const n = Number(raw);
        return Number.isFinite(n) ? n : raw;
      }
      return raw;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      return raw;
    }
    case "list": {
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") {
        return raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      return raw;
    }
    default:
      return raw;
  }
}

/** Дефолты схемы как плоский объект (без секретов — секреты без дефолта). */
export function schemaDefaults(defs: readonly PluginSettingDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    if (def.default !== undefined && !(def.secret === true)) out[def.key] = def.default;
  }
  return out;
}

/**
 * Эффективные значения: дефолты под хранимым. Неизвестные хранимые ключи
 * сохраняются в выходе (forward-compat), UI их не рисует.
 */
export function mergeWithDefaults(
  defs: readonly PluginSettingDef[],
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = schemaDefaults(defs);
  for (const [key, value] of Object.entries(stored)) {
    const def = defs.find((d) => d.key === key);
    if (!def) {
      out[key] = value;
      continue;
    }
    const coerced = coerceValue(def, value);
    if (checkValue(def, coerced) === null) out[key] = coerced;
  }
  return out;
}

/**
 * Редактируемый вид для REST/UI: секреты заменены на `""`, их имена — в
 * `hasSecrets` (пустое в `PUT` оставляет хранимое).
 */
export function redactSecrets(
  defs: readonly PluginSettingDef[],
  values: Record<string, unknown>,
): { values: Record<string, unknown>; hasSecrets: string[] } {
  const shown: Record<string, unknown> = { ...values };
  const hasSecrets: string[] = [];
  for (const def of defs) {
    if (def.secret !== true) continue;
    if (values[def.key] !== undefined && values[def.key] !== "") hasSecrets.push(def.key);
    shown[def.key] = "";
  }
  return { values: shown, hasSecrets };
}

/**
 * Применяет частичный PUT к хранимым значениям. Пустой секрет оставляет
 * хранимое; неизвестный ключ и невалидное значение — ошибка (первая).
 */
export function applyPatch(
  defs: readonly PluginSettingDef[],
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): { values: Record<string, unknown> } | { error: string } {
  const next: Record<string, unknown> = { ...stored };
  for (const [key, raw] of Object.entries(patch)) {
    const def = defs.find((d) => d.key === key);
    if (!def) return { error: `unknown-key: ${key}` };
    if (
      def.secret === true &&
      (raw === "" || raw === undefined || raw === null) &&
      stored[key] !== undefined
    ) {
      continue;
    }
    const coerced = coerceValue(def, raw);
    const problem = checkValue(def, coerced);
    if (problem) return { error: `invalid-value: ${key} (${problem})` };
    next[key] = coerced;
  }
  return { values: next };
}
