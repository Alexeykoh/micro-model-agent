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
   * Нужна ли миграция: конфиг ЯВНО помечен как v1 (`__schema: 1`) или содержит
   * v1-формы провайдера (плоские `apiBase`/`apiKey` без `provider.entries`).
   *
   * Раньше «нет всех обязательных v2-полей» считалось v1 — так помечался
   * частично подредактированный v2-конфиг, и он УДАЛЯЛСЯ (аудит §7.1).
   */
  needsMigration(): boolean {
    const configPath = join(this.configDir, "config.json");
    if (!existsSync(configPath)) return false;

    try {
      const content = readFileSync(configPath, "utf-8");
      const config = JSON.parse(content) as Record<string, unknown>;

      // Явный маркер формата.
      if (config.__schema === 1) return true;
      if (typeof config.version === "string" && config.version.startsWith("2.")) return false;

      for (const field of V1_ONLY_FIELDS) {
        if (field in config) return true;
      }

      // Плоский провайдер без `entries` и без маркера v2 — v1-форма. Если
      // `entries` есть, конфиг уже v2, даже если не хватает части ключей.
      const provider = config.provider as Record<string, unknown> | undefined;
      if (provider && typeof provider === "object" && Array.isArray(provider.entries)) {
        return false;
      }
      if (provider && typeof provider === "object" && typeof provider.baseUrl === "string") {
        return true;
      }

      // Ни маркера версии, ни признаков v2 — конфиг старого формата. Если
      // какие-то v2-ключи есть (provider, contextWindow, contextBudget), конфиг
      // подредактированный, а не v1: удалять его нельзя (аудит §7.1).
      const v2Markers = ["provider", "contextWindow", "contextBudget"];
      if (v2Markers.some((f) => f in config)) return false;
      return typeof config.version !== "string";
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
