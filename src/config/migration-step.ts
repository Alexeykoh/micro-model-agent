// Шаг миграции v1 → v2 при загрузке конфига: бэкап, конвертация, запись.
//
// Вынесено из `config.ts`: миграция — отдельная операция со своим жизненным
// циклом (бэкап → конверт → запись), и загрузчик конфига не должен расти из-за
// неё (правило 6 AGENTS).
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { t } from "../i18n/index";
import { defaultOutputBus } from "../output";
import { BackupManager } from "../migration/backup";
import { convertV1toV2 } from "../migration/convert";
import { regexReplacer } from "./utils";

/**
 * Мигрирует legacy config.json, если он распознан как v1.
 *
 * Порядок: полный бэкап → снапшот config.json → конвертация в v2 → запись
 * `config.json.migrated`. Исходный файл удаляется ТОЛЬКО если конвертация не
 * удалась (аудит §7.1: раньше v1-конфиг удалялся молча).
 *
 * @returns сконвертированный конфиг (для мержа в рантайм) или null.
 */
export function runLegacyMigration(
  configDir: string,
  globalPath: string,
): Record<string, unknown> | null {
  const backup = new BackupManager(configDir);
  backup.backupAll();
  backup.backupConfig();
  const summary = backup.getBackupSummary();
  defaultOutputBus.log("warn", "module:config", t("migration.detected", { summary }));

  const converted = convertLegacyConfig(globalPath);
  if (converted) return converted;

  try {
    unlinkSync(globalPath);
  } catch (e) {
    // Best-effort удаление: loadConfig откатится на дефолты, но leftover
    // v1-файл ретриггерил бы миграцию на каждом старте.
    defaultOutputBus.log(
      "error",
      "module:config",
      `[config] failed to remove legacy config.json: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return null;
}

/**
 * Конвертирует legacy config.json в v2 и сохраняет результат рядом
 * (`config.json.migrated`), чтобы данные не пропали.
 *
 * @returns сконвертированный конфиг или null, если конвертация не удалась.
 */
function convertLegacyConfig(globalPath: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
    const converted = convertV1toV2(raw);
    writeFileSync(`${globalPath}.migrated`, JSON.stringify(converted, regexReplacer, 2), "utf-8");
    return converted;
  } catch (e) {
    defaultOutputBus.log(
      "error",
      "module:config",
      `[config] failed to convert legacy config: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
