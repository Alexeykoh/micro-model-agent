// Команды конфига и бюджета контекста: config set/show/migrate, context.
import type { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { getDefaultChannel, writeMachineJson } from "../output";
import { setConfigValue } from "../config/registry";
import { redactConfigSecrets } from "../config/redact";
import { MMA_DIR_NAME, globalConfigFile } from "../config/paths";
import { fail } from "./exit-code";
import { budgetBreakdownLines, setBudgetShare } from "../config/budget";

/** Конфиг для `mma config show`: секреты затёрты, если явно не просили. */
export function configForDisplay<T>(config: T, showSecrets?: boolean): T {
  return showSecrets ? config : redactConfigSecrets(config);
}

export function buildConfigCommands(program: Command): void {
  const configCmd = program.command("config").description(t("cli.manage_config"));
  configCmd
    .command("set")
    .argument("<key>", t("cli.config_key"))
    .argument("<value>", t("cli.config_value"))
    .description(t("cli.set_value"))
    .option("--force", t("cli.config_force"))
    .action(async (key: string, value: string, opts: { force?: boolean }) => {
      const configPath = globalConfigFile();
      const { config } = await bootstrap();
      if (opts.force) {
        const keys = key.split(".");
        let obj = config as unknown as Record<string, unknown>;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!(keys[i] in obj) || typeof obj[keys[i]] !== "object" || obj[keys[i]] === null) {
            obj[keys[i]] = {};
          }
          obj = obj[keys[i]] as Record<string, unknown>;
        }
        const lastKey = keys[keys.length - 1];
        if (value === "true") obj[lastKey] = true;
        else if (value === "false") obj[lastKey] = false;
        else if (/^\d+$/.test(value)) obj[lastKey] = parseInt(value, 10);
        else if (/^\d+\.\d+$/.test(value)) obj[lastKey] = parseFloat(value);
        else obj[lastKey] = value;
        saveConfig(config, configPath, dirname(configPath));
        getDefaultChannel().writeLine(t("cli.set_done", { key, value }));
        return;
      }
      const r = setConfigValue(config, key, value);
      if (!r.ok) {
        fail(t("cli.config_invalid", { key: r.input, reason: r.reason }));
        return;
      }
      saveConfig(config, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.set_done", { key: r.key, value: r.display }));
    });
  configCmd
    .command("show")
    .description(t("cli.show_config"))
    .option("--show-secrets", t("cli.show_secrets"))
    .action(async (opts: { showSecrets?: boolean }) => {
      const { config } = await bootstrap();
      writeMachineJson(configForDisplay(config, opts.showSecrets));
    });
  configCmd
    .command("migrate")
    .description(t("cli.migrate_config"))
    .action(async () => {
      const { loadConfig } = await import("../config/config");
      const { hasDomainFiles } = await import("../config/domains");
      const configDir = join(homedir(), MMA_DIR_NAME);
      const configPath = join(configDir, "config.json");

      if (hasDomainFiles(configDir)) {
        getDefaultChannel().writeLine(pc.yellow(t("config.migrate_no_legacy")));
        return;
      }

      if (!existsSync(configPath)) {
        getDefaultChannel().writeLine(pc.yellow(t("config.migrate_no_legacy")));
        return;
      }

      getDefaultChannel().writeLine(t("config.migrate_start"));

      const { config } = loadConfig({ configDir, projectConfigPath: join(configDir, ".mmrc") });
      saveConfig(config, configPath, configDir);

      // Переименование legacy-файла.
      const bakPath = `${configPath}.bak`;
      const { renameSync } = await import("fs");
      renameSync(configPath, bakPath);

      const { readdirSync } = await import("fs");
      const domainFiles = readdirSync(join(configDir, "config")).filter((f: string) =>
        f.endsWith(".json"),
      );
      getDefaultChannel().writeLine(
        pc.green(t("config.migrate_done", { count: String(domainFiles.length) })),
      );
    });
}

export function buildContextCommand(program: Command): void {
  program
    .command("context")
    .description(t("cli.manage_context"))
    .argument("[size]", t("cli.context_size_arg"))
    .option("--system <fraction>", t("cli.context_system_fraction"))
    .option("--reserve <fraction>", t("cli.context_reserve_fraction"))
    .action(async (size: string | undefined, opts: { system?: string; reserve?: string }) => {
      const { config, configDir } = await bootstrap();
      const configPath = join(configDir, "config.json");

      if (opts.system !== undefined || opts.reserve !== undefined) {
        const key = opts.system !== undefined ? "system" : "reserve";
        const value = Number(opts.system ?? opts.reserve);
        if (setBudgetShare(config, key, value) !== null) {
          fail(t("cli.context_invalid_fraction"));
          return;
        }
        saveConfig(config, configPath, dirname(configPath));
        getDefaultChannel().writeLine(t("cli.context_fraction_set", { key, value }));
        return;
      }

      if (size === undefined) {
        for (const line of budgetBreakdownLines(config)) getDefaultChannel().writeLine(line);
        return;
      }

      const contextWindow = parseInt(size, 10);
      if (Number.isNaN(contextWindow) || contextWindow < 1024) {
        fail(t("cli.invalid_context_size"));
        return;
      }
      config.contextWindow = contextWindow;
      // Явное окно = ручной режим: проба провайдера его больше не перетирает.
      config.contextAuto = false;
      saveConfig(config, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.context_set", { size: contextWindow }));
    });
}
