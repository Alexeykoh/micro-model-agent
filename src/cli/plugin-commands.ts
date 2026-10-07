import type { Command } from "commander";
import { join } from "path";
import { bootstrap } from "../core/bootstrap";
import { readMmaVersion } from "../core/version";
import { t } from "../i18n/index";
import { getDefaultChannel } from "../output";
import { setConfigValue } from "../config/registry";
import { saveConfig } from "../config/config";
import { formatPluginDetails, formatPluginList } from "../modules/plugins/format";
import { reloadSummaryLines } from "../modules/plugins/reload";
import type { PluginManager } from "../modules/plugins/manager";

// CLI-группа `mma plugins`: список, подробности, вкл/выкл.

/** Печатает список через общий формат (тот же, что у `/plugins` в REPL). */
function printList(manager: PluginManager, all: boolean): void {
  const records = manager.getRecords();
  const failures = manager.getFailures();
  const visible = all ? records : records.filter((r) => !r.builtin);
  const lines = formatPluginList(records, failures, {
    showBuiltin: all,
    mmaVersion: readMmaVersion(),
  });
  if (visible.length === 0 && failures.length === 0) {
    getDefaultChannel().writeLine(t("cli.plugins.none"));
    return;
  }
  for (const line of lines) getDefaultChannel().writeLine(line);
  if (!all && visible.length > 0) getDefaultChannel().writeLine(t("cli.plugins.only_external"));
}

/**
 * Создаёт группу субкоманд `mma plugins`.
 */
export function createPluginCommand(program: Command): void {
  const pluginsCmd = program.command("plugins").description(t("cli.plugins.description"));

  pluginsCmd
    .command("list")
    .description(t("cli.plugins.list"))
    .option("-a, --all", t("cli.plugins.all"))
    .action(async (cmdOpts: { all?: boolean }) => {
      const { pluginManager } = await bootstrap();
      printList(pluginManager, cmdOpts.all === true);
    });

  pluginsCmd
    .command("show")
    .description(t("cli.plugins.show"))
    .argument("<name>", t("cli.plugins.show"))
    .action(async (name: string) => {
      const { pluginManager } = await bootstrap();
      const record = pluginManager.getRecords().find((r) => r.name === name);
      const channel = getDefaultChannel();
      if (!record) {
        channel.writeLine(t("cli.plugins.not_found", { name }));
        return;
      }
      for (const line of formatPluginDetails(record, pluginManager.getFailures())) {
        channel.writeLine(line);
      }
    });

  pluginsCmd
    .command("reload")
    .description(t("plugin.reload"))
    .action(async () => {
      const { pluginManager, skillsModule } = await bootstrap();
      const channel = getDefaultChannel();
      const plugins = pluginManager.reload();
      const skills = skillsModule?.reloadSources() ?? { added: 0, removed: 0 };
      for (const line of reloadSummaryLines(plugins, skills)) channel.writeLine(line);
    });

  for (const [name, on, key] of [
    ["enable", true, "cli.plugins.enable"],
    ["disable", false, "cli.plugins.disable"],
  ] as const) {
    pluginsCmd
      .command(name)
      .description(t(key))
      .argument("<name>", t(key))
      .action(async (pluginName: string) => {
        const { pluginManager, config, configDir } = await bootstrap();
        const channel = getDefaultChannel();
        if (!pluginManager.getPlugin(pluginName)) {
          channel.writeLine(t("cli.plugins.not_found", { name: pluginName }), "stderr");
          return;
        }
        // Единый путь записи: setConfigValue сам применит deny-list к живому
        // реестру (шов в registry.ts) — и CLI, и REPL, и веб идут через него.
        const current = new Set(config.plugins?.disabled ?? []);
        if (on) current.delete(pluginName);
        else current.add(pluginName);
        const result = setConfigValue(config, "plugins.disabled", [...current].join(","));
        if (!result.ok) {
          channel.writeLine(t("config.invalid_value", { key: "plugins.disabled" }), "stderr");
          return;
        }
        saveConfig(config, join(configDir, "config.json"), configDir);
        channel.writeLine(`${pluginName}  ${on ? t("cli.plugins.on") : t("cli.plugins.off")}`);
      });
  }
}
