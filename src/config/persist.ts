// Персист «одного изменения» конфига (INV-20).
//
// `saveConfig` пишет ВСЕ домены из переданного снимка: если поверхность держит
// конфиг с bootstrap, а CLI параллельно изменил другой домен, полный сейв
// затирает чужую правку (аудит 7.5). Здесь — единая точка для поверхностей,
// которые меняют один ключ: пишем ТОЛЬКО домен тронутого ключа («merge только
// изменённого ключа»). Плюс версия конфига, которую поверхность читает вместе
// со снимком `{version, config}`.
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { AppConfig } from "./types";
import { CONFIG_FILE, saveConfig, stripEnvOverrides } from "./config";
import { domainForKey, extractDomain, getDomainFilePath } from "./domains";
import { resolveConfigKey } from "./registry";
import { regexReplacer } from "./utils";

// Реэкспорт: поверхность вяжет saveConfig-хук через этот фасад (один импорт).
export { CONFIG_FILE };

/** Версии конфига — на объект (INV-20): растёт на каждой записи/применении. */
const VERSIONS = new WeakMap<AppConfig, number>();

/** Текущая версия конфига: 0, пока не было записей. */
export function configVersion(config: AppConfig): number {
  return VERSIONS.get(config) ?? 0;
}

/** Домен, которому принадлежит канонический ключ (по первому сегменту поля). */
export function domainForConfigKey(key: string): string | null {
  const def = resolveConfigKey(key);
  if (!def) return null;
  return domainForKey(def.key.split(".")[0]);
}

/**
 * Персистит изменение одного ключа: пишет только домен тронутого ключа, не
 * трогая домены, которые параллельно изменила другая поверхность (INV-20).
 * Неизвестный ключ/домен или отсутствие каталога — полный сейв (совместимость).
 */
export function persistConfigChange(
  config: AppConfig,
  key: string | undefined,
  configPath: string,
  configDir?: string,
): void {
  const domain = key && configDir ? domainForConfigKey(key) : null;
  if (!domain || !configDir) {
    saveConfig(config, configPath, configDir);
    return;
  }
  const file = getDomainFilePath(configDir, domain);
  mkdirSync(dirname(file), { recursive: true });
  const subset = extractDomain(stripEnvOverrides(config), domain);
  writeFileSync(file, JSON.stringify(subset, regexReplacer, 2), "utf-8");
  VERSIONS.set(config, (VERSIONS.get(config) ?? 0) + 1);
}
