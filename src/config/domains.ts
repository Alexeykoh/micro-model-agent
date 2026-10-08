// Домены конфига: раскладка AppConfig по файлам ~/.mma/config/<домен>.json.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type { AppConfig } from "./types";
import { t } from "../i18n/index";
import { deepMerge, regexReplacer, regexReviver } from "./utils";
import { defaultOutputBus } from "../output";

/**
 * Маппинг: имя домена → ключи AppConfig. Каждый домен — один JSON-файл
 * в ~/.mma/config/<domain>.json.
 */
export const CONFIG_DOMAINS: Record<string, (keyof AppConfig)[]> = {
  core: [
    "version",
    "model",
    "contextWindow",
    "contextAuto",
    "contextBudget",
    "instructions",
    "indexer",
    "modelLoad",
    "maxToolIterations",
    "stuckThreshold",
    "autoPlan",
    "execution",
    "showReasoning",
    "logLevel",
    "locale",
    "reasoning",
    "hallucination",
  ],
  provider: ["provider", "orchestrator", "retry", "pricing", "modelCapabilities"],
  moe: ["moe", "experts"],
  critic: ["critic"],
  security: ["security"],
  browser: ["browser"],
  search: ["webSearch", "errorWebSearch"],
  tools: ["tools", "subagent"],
  session: ["session", "sessionIsolation", "contextLog"],
  ui: ["ui", "images"],
  mcp: ["mcpServers"],
  lsp: ["lsp"],
  skills: ["skills"],
  plugins: ["plugins"],
  updater: ["updater"],
  service: ["service"],
};

/** Вырезает подмножество ключей домена из полного AppConfig. */
export function extractDomain(config: AppConfig, domain: string): Record<string, unknown> {
  const keys = CONFIG_DOMAINS[domain];
  if (!keys) return {};
  const subset: Record<string, unknown> = {};
  const source = config as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (source[key] !== undefined) {
      subset[key] = source[key];
    }
  }
  return subset;
}

/** Путь к файлу домена. */
export function getDomainFilePath(configDir: string, domain: string): string {
  return join(configDir, "config", `${domain}.json`);
}

/** Проверяет, есть ли файлы доменов в каталоге config/. */
export function hasDomainFiles(configDir: string): boolean {
  const configDirPath = join(configDir, "config");
  if (!existsSync(configDirPath)) return false;
  try {
    const files = readdirSync(configDirPath);
    return files.some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

/**
 * Грузит все файлы доменов из ~/.mma/config/ и мержит в частичный AppConfig.
 * Каждый файл парсится с regexReviver (восстановление RegExp).
 * Возвращает null, если файлов доменов нет.
 */
export function loadDomainFiles(configDir: string): Partial<AppConfig> | null {
  const configDirPath = join(configDir, "config");
  if (!existsSync(configDirPath)) return null;

  let result: Record<string, unknown> = {};
  let anyLoaded = false;

  for (const domain of Object.keys(CONFIG_DOMAINS)) {
    const filePath = getDomainFilePath(configDir, domain);
    if (!existsSync(filePath)) continue;

    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw, regexReviver as (key: string, value: unknown) => unknown);
      result = deepMerge(result, data);
      anyLoaded = true;
    } catch {
      // Не молчим: показываем битый путь, а не тихо игнорим домен,
      // который пользователь считает активным.
      defaultOutputBus.log("warn", "config", t("config.parse_failed", { path: filePath }));
    }
  }

  return anyLoaded ? (result as Partial<AppConfig>) : null;
}

/**
 * Пишет полный AppConfig по файлам доменов в ~/.mma/config/.
 * Ключи каждого домена вырезаются и пишутся в config/<domain>.json.
 * RegExp сериализуются через regexReplacer.
 */
export function saveDomainFiles(config: AppConfig, configDir: string): void {
  const configDirPath = join(configDir, "config");
  mkdirSync(configDirPath, { recursive: true });

  for (const [domain, keys] of Object.entries(CONFIG_DOMAINS)) {
    const subset: Record<string, unknown> = {};
    let hasContent = false;
    const source = config as unknown as Record<string, unknown>;
    for (const key of keys) {
      if (source[key] !== undefined) {
        subset[key] = source[key];
        hasContent = true;
      }
    }
    if (!hasContent) continue;

    const filePath = getDomainFilePath(configDir, domain);
    writeFileSync(filePath, JSON.stringify(subset, regexReplacer, 2), "utf-8");
  }
}

/**
 * Определяет домен ключа конфига. Возвращает имя домена или null.
 */
export function domainForKey(key: string): string | null {
  for (const [domain, keys] of Object.entries(CONFIG_DOMAINS)) {
    if ((keys as string[]).includes(key)) return domain;
  }
  return null;
}
