import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { t } from "../i18n/index";
import type { AppConfig } from "../config/types";

export class BackupManager {
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  backupConfig(): void {
    const configPath = join(this.configDir, "config.json");
    if (!existsSync(configPath)) return;

    const bakPath = join(this.configDir, "config.json.bak");
    copyFileSync(configPath, bakPath);
  }

  backupAll(): void {
    const bakDir = this.configDir + ".bak";
    if (existsSync(bakDir)) return;

    if (existsSync(this.configDir)) {
      cpSync(this.configDir, bakDir, { recursive: true });
    }
  }

  writeFreshConfig(config: AppConfig): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
    writeFileSync(join(this.configDir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
  }

  getBackupSummary(): string {
    const lines: string[] = [];
    const bakConfig = join(this.configDir, "config.json.bak");
    const bakDir = this.configDir + ".bak";

    if (existsSync(bakConfig)) {
      lines.push(t("migration.config_bak"));
    }
    if (existsSync(bakDir)) {
      const files = readdirSync(bakDir);
      lines.push(t("migration.dir_bak", { count: files.length }));
    }

    return lines.length > 0
      ? `${t("migration.migrated")}\n${lines.join("\n")}`
      : t("migration.not_needed");
  }
}
