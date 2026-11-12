// Хранилище настроек плагинов: свой файл значений у каждого внешнего плагина.
// Путь выводится строго из `plugin.path` — пользователь его не задаёт, поэтому
// traversal невозможен по построению. Кэш — по mtime файла.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { globalMmaDir } from "../../config/paths";
import type { AgentPlugin, PluginSettingDef } from "../types";
import {
  applyPatch,
  mergeWithDefaults,
  redactSecrets,
  schemaDefaults,
  validateSettingsSchema,
} from "./settings-schema";

/** Entry-файлы папок-плагинов (тот же порядок, что в `loader.ts`). */
const FOLDER_ENTRIES = new Set(["plugin.ts", "plugin.js", "index.ts", "index.js"]);

/**
 * Путь файла настроек по пути плагина. Папка-плагин → `settings.json` внутри;
 * файл-плагин → рядом, с тем же basename. Пустого пути нет — null.
 */
export function settingsPathFor(pluginPath: string | undefined): string | null {
  if (!pluginPath) return null;
  const base = basename(pluginPath);
  if (FOLDER_ENTRIES.has(base)) return join(dirname(pluginPath), "settings.json");
  const ext = extname(base);
  return join(dirname(pluginPath), `${base.slice(0, base.length - ext.length)}.settings.json`);
}

/** Плагин может иметь настройки: внешний (не builtin/system) + путь. */
export function canHaveSettings(plugin: AgentPlugin): boolean {
  return (
    plugin.isBuiltin !== true && plugin.system !== true && typeof plugin.path === "string" &&
    plugin.path.length > 0
  );
}

/**
 * Встроенный (не системный) плагин: свой файл лежит не рядом с кодом
 * (в `src/` писать нельзя), а в `<MMA_CONFIG_DIR>/plugin-settings/`.
 */
export function isBuiltinWithSettings(plugin: AgentPlugin): boolean {
  return plugin.isBuiltin === true && plugin.system !== true;
}

/** Файл настроек встроенного плагина (уважает `MMA_CONFIG_DIR`). */
export function builtinSettingsPath(name: string, configDir?: string): string {
  return join(configDir ?? globalMmaDir(), "plugin-settings", `${name}.settings.json`);
}

/** Валидная непустая схема плагина (сырая, из кода). */
export function pluginSettingsDefs(plugin: AgentPlugin): PluginSettingDef[] {
  return validateSettingsSchema(plugin.settingsSchema).defs;
}

/** Читает JSON-объект из файла; нет/битый → `{}` (fail-soft, как мета). */
export function readSettingsFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Битый файл — как отсутствующий, но не затираем его молча при записи
    // (см. `writeSettingsFile`: хранимое читается заново).
  }
  return {};
}

/** Пишет объект в файл, создавая каталог. */
export function writeSettingsFile(path: string, values: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(values, null, 2)}\n`, "utf8");
}

/** Вид настроек для REST/UI. */
export interface PluginSettingsView {
  schema: PluginSettingDef[];
  values: Record<string, unknown>;
  hasSecrets: string[];
}

/** Поиск плагина по имени (менеджер или любой реестр). */
export type PluginFinder = (name: string) => AgentPlugin | null;

/**
 * Стор настроек: резолвит схему и файл по инстансу плагина, валидирует,
 * кэширует эффективные значения по mtime.
 *
 * Внешние плагины → sidecar рядом с кодом; встроенные (не системные) →
 * `<MMA_CONFIG_DIR>/plugin-settings/<name>.settings.json`.
 */
export class PluginSettingsStore {
  private readonly cache = new Map<string, { mtimeMs: number; values: Record<string, unknown> }>();

  constructor(
    private readonly find: PluginFinder,
    private readonly configDir?: string,
  ) {}

  /** Путь файла настроек плагина; null — настроек быть не может. */
  fileOf(plugin: AgentPlugin): string | null {
    if (canHaveSettings(plugin)) return settingsPathFor(plugin.path);
    if (isBuiltinWithSettings(plugin)) return builtinSettingsPath(plugin.name, this.configDir);
    return null;
  }

  /** Схема плагина (пусто — настроек нет). */
  defsOf(plugin: AgentPlugin): PluginSettingDef[] {
    if (!this.fileOf(plugin)) return [];
    return pluginSettingsDefs(plugin);
  }

  /** Запись плагина для `PluginRecord.hasSettings`. */
  hasSettings(plugin: AgentPlugin): boolean {
    return this.defsOf(plugin).length > 0;
  }

  /** Эффективные значения (дефолты + файл, с секретами) для рантайма. */
  getEffective(name: string): Record<string, unknown> {
    const plugin = this.find(name);
    if (!plugin) return {};
    const defs = this.defsOf(plugin);
    if (defs.length === 0) return {};
    const file = this.fileOf(plugin);
    if (!file) return schemaDefaults(defs);
    return this.cachedEffective(name, file, defs);
  }

  /** Вид для REST/UI (секреты redacted). Null — настроек нет. */
  getView(name: string): PluginSettingsView | null {
    const plugin = this.find(name);
    if (!plugin) return null;
    const defs = this.defsOf(plugin);
    if (defs.length === 0) return null;
    const redacted = redactSecrets(defs, this.getEffective(name));
    return { schema: defs, values: redacted.values, hasSecrets: redacted.hasSecrets };
  }

  /**
   * Частичное обновление: валидация → merge → запись файла → инвалидация.
   * Ошибка валидации — строка `unknown-key: …` / `invalid-value: …`.
   */
  update(name: string, patch: Record<string, unknown>): PluginSettingsView | { error: string } {
    const plugin = this.find(name);
    if (!plugin) return { error: "not_found" };
    const defs = this.defsOf(plugin);
    if (defs.length === 0) return { error: "no_settings" };
    const file = this.fileOf(plugin);
    if (!file) return { error: "no_settings" };
    const stored = readSettingsFile(file);
    const applied = applyPatch(defs, stored, patch);
    if ("error" in applied) return applied;
    writeSettingsFile(file, applied.values);
    this.cache.delete(name);
    const redacted = redactSecrets(defs, mergeWithDefaults(defs, applied.values));
    return { schema: defs, values: redacted.values, hasSecrets: redacted.hasSecrets };
  }

  /** Плагин известен менеджеру (для различия 404 not_found/no_settings). */
  known(name: string): boolean {
    return this.find(name) !== null;
  }

  /** Сбросить кэш (reload каталога плагинов). */
  invalidate(name?: string): void {
    if (name) this.cache.delete(name);
    else this.cache.clear();
  }

  private cachedEffective(
    name: string,
    file: string,
    defs: PluginSettingDef[],
  ): Record<string, unknown> {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    const hit = this.cache.get(name);
    if (hit && hit.mtimeMs === mtimeMs) return hit.values;
    const values = mergeWithDefaults(defs, readSettingsFile(file));
    this.cache.set(name, { mtimeMs, values });
    return values;
  }
}

/** Аккуратный предикат «файл настроек существует» (для мусора в выдаче). */
export function settingsFileExists(path: string): boolean {
  return existsSync(path);
}

const builtinCache = new Map<string, { mtimeMs: number; values: Record<string, unknown> }>();

/**
 * Прямое чтение настроек встроенного плагина для рантайма (без менеджера:
 * встроенные живут в процессе с bootstrap и менеджера под рукой нет).
 * Кэш по mtime файла, битый файл — дефолты.
 */
export function readBuiltinSettings(
  name: string,
  schema: readonly PluginSettingDef[],
  configDir?: string,
): Record<string, unknown> {
  const defs = validateSettingsSchema(schema).defs;
  if (defs.length === 0) return {};
  const file = builtinSettingsPath(name, configDir);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const hit = builtinCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.values;
  const values = mergeWithDefaults(defs, readSettingsFile(file));
  builtinCache.set(file, { mtimeMs, values });
  return values;
}
