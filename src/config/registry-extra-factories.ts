// Фабрики дефов реестра (bool/int/share/enum/list/str/json) и мелкие
// предикаты. Вынесены из `registry-extra.ts` (правило 6), чтобы группы
// ключей в `registry-extra-*.ts` не дублировали конструкторы.
import type { AppConfig } from "./types";
import type { ConfigKeyDef, ConfigRangeReason } from "./registry";
import { REBUILD } from "./effects";
import { DEFAULT_SECURITY_CONFIG } from "./security";

/** Фабрика bool-дефа. */
export function bool(
  key: string,
  domain: string,
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "bool", effects: reconfigure ? REBUILD : [], get, set };
}

/** Фабрика int-дефа с min/max/step. */
export function int(
  key: string,
  domain: string,
  min: number,
  max: number,
  step: number,
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "int", min, max, step, effects: reconfigure ? REBUILD : [], get, set };
}

/** Фабрика share-дефа (доля 0.05–0.9). */
export function share(
  key: string,
  domain: string,
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "share", min: 0.05, max: 0.9, step: 0.01, effects: reconfigure ? REBUILD : [], get, set };
}

/** Фабрика enum-дефа. */
export function enumOf(
  key: string,
  domain: string,
  values: readonly string[],
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "enum", enumValues: values, effects: reconfigure ? REBUILD : [], get, set };
}

/** Фабрика list-дефа (без reconfigure, опц. редактор). */
export function list(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
  editor?: ConfigKeyDef["editor"],
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "list", effects: [], editor, get, set };
}

/** Фабрика string-дефа. */
export function str(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "string", effects: [], get, set };
}

/** Опциональная строка: get отдаёт "" при неустановленной, set чистит в undefined на пустой. */
export function strOpt(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return str(key, domain, get, set);
}

/** Фабрика json-дефа с опц. валидацией и редактором. */
export function json(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
  extraValidate?: ConfigKeyDef["extraValidate"],
  editor?: ConfigKeyDef["editor"],
): ConfigKeyDef {
  return {
    key,
    aliases: [],
    domain,
    valueType: "json",
    effects: [],
    editor,
    get,
    set,
    extraValidate,
  };
}

/** JSON-деф с предикатом формы; всё, не прошедшее проверку, — "invalid". */
export function jsonShape(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
  check: (v: unknown) => boolean,
  editor?: ConfigKeyDef["editor"],
): ConfigKeyDef {
  const extraValidate = (_c: AppConfig, v: unknown): ConfigRangeReason | "invalid" | null =>
    check(v) ? null : "invalid";
  return json(key, domain, get, set, extraValidate, editor);
}

/** Лениво создаёт опциональное гнездо security и возвращает его. */
export function sec(c: AppConfig) {
  c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
  return c.security;
}

/** Проверка на запись (объект-не-массив). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Проверка на неотрицательное число. */
export function isNonNegNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
