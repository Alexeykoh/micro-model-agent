// Домены конфига: раскладка AppConfig по файлам ~/.mma/config/<домен>.json.
import {
  existsSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join } from "path";
import type { AppConfig } from "./types";
import { t } from "../i18n/index";
import { deepMerge, regexReplacer, } from "./utils";
import { defaultOutputBus } from "../output";
import { mergeThreeWay, readDomainFile, writeFileAtomic } from "./domain-io";
import { ConfigEncryptor } from "../modules/security/encryption";

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
  provider: ["provider", "retry", "pricing", "modelCapabilities"],
  experts: ["experts"],
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

    // Битый файл — в карантин (`<file>.corrupt-<ts>`), а не молчаливый откат
    // на дефолты (аудит §7.4).
    const data = readDomainFile(filePath);
    if (Object.keys(data).length === 0) continue;
    result = deepMerge(result, decryptDomain(data));
    anyLoaded = true;
  }

  if (!anyLoaded) return null;
  const partial = result as Partial<AppConfig>;
  rememberSnapshot(configDir, partial as AppConfig);
  return partial;
}

/**
 * Расшифровывает чувствительные поля доменного файла (если они зашифрованы).
 * Без ключа значения остаются как есть — пользователь увидит их в панели.
 */
function decryptDomain(data: Record<string, unknown>): Record<string, unknown> {
  try {
    const encryptor = new ConfigEncryptor();
    return encryptor.decrypt(data);
  } catch {
    return data;
  }
}

/**
 * Пишет полный AppConfig по файлам доменов в ~/.mma/config/.
 * Ключи каждого домена вырезаются и пишутся в config/<domain>.json.
 * RegExp сериализуются через regexReplacer.
 *
 * Запись атомарна (tmp → fsync → rename) и НЕ затирает чужие изменения:
 * домен мержится с тем, что лежит на диске (аудит §7.4/§7.5).
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
    const theirs = readDomainFile(filePath);
    const base = baseSnapshot(configDir)[domain] ?? {};
    const merged = mergeThreeWay(base, subset, theirs);
    writeFileAtomic(filePath, JSON.stringify(encryptDomain(merged), regexReplacer, 2));
  }
  rememberSnapshot(configDir, config);
}

/**
 * Шифрует чувствительные поля домена (apiKey, service.token, webhookSecret,
 * env MCP-серверов). Раньше они лежали на диске открытым текстом (аудит §7.4).
 * Если ключа нет/он битый — пишем открыто и предупреждаем: конфиг должен
 * остаться рабочим.
 */
function encryptDomain(data: Record<string, unknown>): Record<string, unknown> {
  try {
    const encryptor = new ConfigEncryptor();
    return encryptor.encrypt(data);
  } catch (e) {
    defaultOutputBus.log(
      "warn",
      "module:config",
      t("config.encryption_warning", { error: e instanceof Error ? e.message : String(e) }),
    );
    return data;
  }
}

/**

/** Снимок последнего загруженного/сохранённого конфига (база для слияния). */
const snapshots = new Map<string, Record<string, Record<string, unknown>>>();

/** Снимок по каталогу конфига. */
function baseSnapshot(configDir: string): Record<string, Record<string, unknown>> {
  return snapshots.get(configDir) ?? {};
}

/** Запомнить снимок после загрузки/сохранения. */
function rememberSnapshot(configDir: string, config: Partial<AppConfig>): void {
  const source = { ...config } as Record<string, unknown>;
  const byDomain: Record<string, Record<string, unknown>> = {};
  for (const [domain, keys] of Object.entries(CONFIG_DOMAINS)) {
    const subset: Record<string, unknown> = {};
    for (const key of keys) {
      if (source[key] !== undefined) subset[key] = source[key];
    }
    byDomain[domain] = subset;
  }
  snapshots.set(configDir, byDomain);
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
