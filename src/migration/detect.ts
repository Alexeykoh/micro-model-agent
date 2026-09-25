import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const V1_ONLY_FIELDS = ["apiBase", "apiKey", "chatEndpoint", "temperature", "maxTokens"];

export class MigrationDetector {
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

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
      // A corrupt or hand-edited config must NOT be treated as v1 and deleted.
      // loadConfig will warn and fall back to defaults instead.
      return false;
    }
  }

  hasOldSessions(): boolean {
    const sessionsDir = join(this.configDir, "sessions");
    if (!existsSync(sessionsDir)) return false;
    return readdirSync(sessionsDir).length > 0;
  }

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
