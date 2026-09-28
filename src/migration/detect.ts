// Детект необходимости миграции: отличает конфиг v1 от v2 и битого файла.
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const V1_ONLY_FIELDS = ["apiBase", "apiKey", "chatEndpoint", "temperature", "maxTokens"];

/** Проверяет, лежит ли в configDir конфиг формата v1. Битый файл — не v1. */
export class MigrationDetector {
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  /**
   * Нужна ли миграция: есть v1-поля или нет всех обязательных v2-полей.
   * Битый/вручную правленный конфиг — не повод: loadConfig предупредит
   * и откатится на дефолты, файл не трогаем.
   */
  needsMigration(): boolean {
    const configPath = join(this.configDir, "config.json");
    if (!existsSync(configPath)) return false;

    try {
      const content = readFileSync(configPath, "utf-8");
      const config = JSON.parse(content);

      if (config.version?.startsWith("2.")) return false;

      for (const field of V1_ONLY_FIELDS) {
        if (field in config) return true;
      }

      const v2Required = ["provider", "contextWindow", "contextBudget"];
      const hasAllV2Fields = v2Required.every((f) => f in config);
      if (!hasAllV2Fields) return true;

      return false;
    } catch {
      // Битый или вручную правленный конфиг — НЕ v1, удалять нельзя.
      // loadConfig предупредит и откатится на дефолты.
      return false;
    }
  }

  /** Есть ли старые сессии в каталоге sessions. */
  hasOldSessions(): boolean {
    const sessionsDir = join(this.configDir, "sessions");
    if (!existsSync(sessionsDir)) return false;
    return readdirSync(sessionsDir).length > 0;
  }

  /** Профиль старого формата: есть profile.json без полей platform/os. */
  hasOldProfile(): boolean {
    const profilePath = join(this.configDir, "profile.json");
    if (!existsSync(profilePath)) return false;
    try {
      const profile = JSON.parse(readFileSync(profilePath, "utf-8"));
      return !profile.platform && !profile.os;
    } catch {
      return false;
    }
  }
}
