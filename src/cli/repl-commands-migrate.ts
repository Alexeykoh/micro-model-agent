/**
 * `/config migrate` — перенос legacy `config.json` на доменные файлы.
 *
 * Вынесено из `repl-commands.ts` (правило 6).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { saveConfig } from "../config/config";
import { existsSync } from "fs";
import { join } from "path";
import type { ReplContext } from "./repl-commands";

export async function runConfigMigrate(ctx: ReplContext): Promise<void> {
  const { hasDomainFiles } = await import("../config/domains");
  const { loadConfig: loadCfg } = await import("../config/config");
  const configDir = ctx.configDir;
  const configPath = join(configDir, "config.json");

  if (hasDomainFiles(configDir)) {
    ctx.output.writeLine(pc.yellow(t("config.migrate_no_legacy")));
    return;
  }

  if (!existsSync(configPath)) {
    ctx.output.writeLine(pc.yellow(t("config.migrate_no_legacy")));
    return;
  }

  ctx.output.writeLine(t("config.migrate_start"));

  const { config } = loadCfg({ configDir, projectConfigPath: join(configDir, ".mmrc") });
  saveConfig(config, configPath, configDir);

  const { renameSync, readdirSync } = await import("fs");
  renameSync(configPath, `${configPath}.bak`);

  const domainFiles = readdirSync(join(configDir, "config")).filter((f: string) =>
    f.endsWith(".json"),
  );
  ctx.output.writeLine(pc.green(t("config.migrate_done", { count: String(domainFiles.length) })));
}
