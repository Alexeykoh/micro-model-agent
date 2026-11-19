// Загрузка/сохранение конфига: DEFAULTS → legacy → домены → .mmrc → env → decrypt.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { DEFAULTS } from "./defaults";
import { DEFAULT_SECURITY_CONFIG } from "./security";
import { t } from "../i18n/index";
import type { AppConfig } from "./types";
import { deepMerge, regexReplacer, regexReviver } from "./utils";
export { deepMerge };
import { MigrationDetector } from "../migration/detect";
import { runLegacyMigration } from "./migration-step";
import { validateExpertConfig } from "./experts";
import { ConfigEncryptor } from "../modules/security/encryption";
import { loadDomainFiles, saveDomainFiles } from "./domains";
import {
  applyCriticTimeoutMigration,
  applyExpertModelMigration,
  normalizeLspServerArgs,
  reportShortCriticTimeout,
} from "./migrate-legacy";
import { defaultOutputBus } from "../output";
import { MMA_DIR_NAME } from "./paths";

// ── Централизованные константы путей ──────────────────────────────────────
/** Глобальный каталог конфига. */
export const CONFIG_DIR = join(homedir(), MMA_DIR_NAME);
/** Legacy-файл конфига. */
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
/** Каталог файлов доменов. */
export const CONFIG_DOMAIN_DIR = join(CONFIG_DIR, "config");

// ── Внутренние хелперы ────────────────────────────────────────────────────

/**
 * Восстанавливает RegExp в `dangerousPatterns`; `"[object Object]"` — след
 * старого wire-бага (`GET /api/config` отдавал `{}`) — считаем мусором.
 */
function restoreDangerousPatterns(patterns: unknown, defaults: unknown): RegExp[] {
  const fallback = (Array.isArray(defaults) ? defaults : []) as RegExp[];
  if (!Array.isArray(patterns) || patterns.length === 0) return fallback;
  const restored = patterns.map((p) => {
    if (p instanceof RegExp) return p.source === "[object Object]" ? null : p;
    if (p && typeof p === "object") {
      const { source, flags } = p as { source?: string; flags?: string };
      if (source && typeof source === "string" && source !== "[object Object]") {
        try {
          return new RegExp(source, flags || "");
        } catch {
          // fall through
        }
      }
    }
    return null;
  });
  // Весь набор — мусор: вернуть полные дефолты, а не первые N.
  if (restored.every((p) => p === null)) return fallback;
  return restored.map((p, i) => p ?? fallback[i] ?? fallback[0]);
}

/** Чтение JSON с восстановлением RegExp. Битый файл — warn с путём, не тишина. */
function loadJSON(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(
      readFileSync(path, "utf-8"),
      regexReviver as (key: string, value: unknown) => unknown,
    ) as Record<string, unknown>;
  } catch {
    // Не молчим: конфиг с опечаткой не должен тихо затирать настройки юзера.
    defaultOutputBus.log("warn", "module:config", t("config.parse_failed", { path }));
  }
  return null;
}

import { applyEnvVars, rememberEnvOverrides, stripEnvOverrides } from "./env-overrides";
export { stripEnvOverrides } from "./env-overrides";

export interface LoadConfigOptions {
  configDir: string;
  projectConfigPath: string;
}

export interface LoadConfigResult {
  config: AppConfig;
  /** true, если использовался legacy config.json (файлов доменов нет). */
  legacyDetected: boolean;
}

/**
 * Грузит конфиг из файлов доменов (предпочтительно) или legacy config.json.
 *
 * Конвейер:
 *   1. DEFAULTS
 *   2. deepMerge(legacy config.json)  — если есть
 *   3. deepMerge(файлы доменов)       — если есть, поверх legacy
 *   4. deepMerge(проектный .mmrc)     — поверх всего
 *   5. Пост-загрузочные фиксы (RegExp, LSP-args)
 *   6. Env-переменные
 *   7. Decrypt
 *
 * На первом запуске (нет ни config.json, ни доменов) результат — DEFAULTS;
 * ничего не пишется: персист только через `saveConfig`.
 */
export function loadConfig(options: LoadConfigOptions): LoadConfigResult {
  const globalPath = join(options.configDir, "config.json");

  mkdirSync(options.configDir, { recursive: true });

  // Проверка v1 → v2 (читает config.json напрямую, до логики доменов).
  const detector = new MigrationDetector(options.configDir);
  const migrated = detector.needsMigration()
    ? runLegacyMigration(options.configDir, globalPath)
    : null;

  // Глубокий клон: DEFAULTS держит синглтон-объекты (security, lsp, tools…),
  // которые рантайм-изменения конфига мутировать не должны.
  let config: AppConfig = structuredClone(DEFAULTS);
  let legacyDetected = false;

  // Шаг 2: legacy config.json (фолбэк). Если конфиг уже сконвертирован из v1,
  // сырые v1-поля НЕ мержатся (в них другие имена модели и плоский провайдер).
  const globalData = migrated ? null : loadJSON(globalPath);
  if (globalData) {
    applyCriticTimeoutMigration(globalData as Partial<AppConfig>);
    applyExpertModelMigration(globalData as Partial<AppConfig>);
    config = deepMerge(config, globalData as Partial<AppConfig>);
    legacyDetected = true;
  }
  if (migrated) {
    // Из сконвертированного v1 в рантайм идут провайдер и лимиты контекста.
    // Имя модели из v1 НЕ переносим: там были другие идентификаторы
    // (`qwen2.5-7b` против `qwen/qwen3.5-9b`), и подставить его — значит
    // сломать выбор модели. Полная копия — в `config.json.migrated`.
    const { provider, contextWindow, contextBudget } = migrated as Record<string, unknown>;
    config = deepMerge(config, {
      provider,
      contextWindow,
      contextBudget,
    } as Partial<AppConfig>);
  }

  // Шаг 3: файлы доменов (поверх legacy).
  const domainConfig = loadDomainFiles(options.configDir);
  if (domainConfig) {
    applyCriticTimeoutMigration(domainConfig);
    applyExpertModelMigration(domainConfig);
    config = deepMerge(config, domainConfig);
    legacyDetected = false;
  }

  // Шаг 4: проектный .mmrc (поверх всего).
  const projectData = loadJSON(options.projectConfigPath);
  if (projectData) {
    applyCriticTimeoutMigration(projectData as Partial<AppConfig>);
    applyExpertModelMigration(projectData as Partial<AppConfig>);
    config = deepMerge(config, projectData as Partial<AppConfig>);
  }

  // Шаг 5: пост-загрузочные фиксы — ПОСЛЕ всех мержей.
  if (config.security?.contentScan?.dangerousPatterns) {
    config.security.contentScan.dangerousPatterns = restoreDangerousPatterns(
      config.security.contentScan.dangerousPatterns,
      DEFAULT_SECURITY_CONFIG.contentScan.dangerousPatterns,
    );
  }
  normalizeLspServerArgs(config);
  reportShortCriticTimeout(config);

  // Шаг 6: env-переменные.
  const { config: envConfig, overrides } = applyEnvVars(config);
  config = envConfig;

  // Шаг 7: decrypt.
  try {
    const encryptor = new ConfigEncryptor();
    const decrypted = encryptor.decrypt(config as unknown as Record<string, unknown>);
    const configRec = config as unknown as Record<string, unknown>;
    for (const key of Object.keys(decrypted)) {
      configRec[key] = decrypted[key];
    }
    // Decrypt пересобирает дерево объектов (новые identity). Переприцеливаем
    // provider-оверрайд на пост-decrypt провайдер, чтобы save-time identity-чек
    // в stripEnvOverrides по-прежнему сходился с загруженным конфигом.
    const providerOverride = overrides.find((o) => o.key === "provider");
    if (providerOverride) providerOverride.envValue = config.provider;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    defaultOutputBus.log("warn", "module:config", t("config.decryption_warning", { error: message }));
  }

  if (overrides.length > 0) rememberEnvOverrides(config, overrides);

  return { config, legacyDetected };
}

/** Валидирует конфиг против известных тегов тулов. Ошибки — throw. */
export function validateConfig(config: AppConfig, allToolTags: string[]): void {
  const errors = validateExpertConfig(config, allToolTags);
  const knownTags = new Set(allToolTags);
  for (const tag of config.tools?.defaultTags ?? []) {
    if (!knownTags.has(tag)) {
      errors.push(
        `tools.defaultTags references unknown tag "${tag}". Known tags: ${Array.from(knownTags).join(", ")}`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n${errors.join("\n")}`);
  }
}

/**
 * Пишет конфиг в файлы доменов (предпочтительно) или legacy-файл (фолбэк).
 *
 * @param config      полный AppConfig для сохранения;
 * @param configPath  legacy-путь (напр. ~/.mma/config.json) — когда configDir нет;
 * @param configDir   каталог конфига (напр. ~/.mma). Если задан — пишет файлы доменов.
 */
export function saveConfig(config: AppConfig, configPath: string, configDir?: string): void {
  // Сессионные MMA_*-оверрайды персистить нельзя (C4).
  const toWrite = stripEnvOverrides(config);
  if (configDir) {
    saveDomainFiles(toWrite, configDir);
    return;
  }

  // Legacy-запись одним файлом (обратная совместимость для тестов/крайних случаев).
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });

  try {
    const encryptor = new ConfigEncryptor();
    const encryptedConfig = encryptor.encrypt({
      ...toWrite,
    } as unknown as Record<string, unknown>);
    writeFileSync(configPath, JSON.stringify(encryptedConfig, regexReplacer, 2), "utf-8");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    defaultOutputBus.log("warn", "module:config", t("config.encryption_warning", { error: message }));
    writeFileSync(configPath, JSON.stringify(toWrite, regexReplacer, 2), "utf-8");
  }
}
