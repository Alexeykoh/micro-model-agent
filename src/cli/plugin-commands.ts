import type { Command } from "commander";
import { join } from "path";
import { bootstrap } from "../core/bootstrap";
import { readMmaVersion } from "../core/version";
import { t } from "../i18n/index";
import { getDefaultChannel } from "../output";
import { fail } from "./exit-code";
import { setConfigValue } from "../config/registry";
import { saveConfig } from "../config/config";
import { formatPluginDetails, formatPluginList } from "../modules/plugins/format";
import type { PluginLoadFailure, PluginRecord } from "../modules/plugins/records";
import { reloadSummaryLines } from "../modules/plugins/reload";
import { draftsDir } from "../modules/plugins/drafts";
import type { PluginManager } from "../modules/plugins/manager";
import { pc } from "../ui/colors";

// CLI-группа `mma plugins`: список, подробности, вкл/выкл.

/**
 * Строки листинга `mma plugins list`. Вынесено из `printList` ради гварда:
 * «плагинов нет» — неправда, когда загружены встроенные (они скрыты по
 * умолчанию, но `mma doctor` в том же конфиге печатает `Plugins [ok] 10 active`).
 */
export function pluginListLines(
  records: PluginRecord[],
  failures: PluginLoadFailure[],
  all: boolean,
  mmaVersion: string,
): string[] {
  const visible = all ? records : records.filter((r) => !r.builtin);
  if (visible.length === 0 && failures.length === 0) {
    const hidden = records.filter((r) => r.builtin).length;
    return [hidden > 0 && !all ? t("cli.plugins.none_external") : t("cli.plugins.none")];
  }
  const lines = formatPluginList(records, failures, { showBuiltin: all, mmaVersion });
  if (!all && visible.length > 0) lines.push(t("cli.plugins.only_external"));
  return lines;
}

/** Печатает список через общий формат (тот же, что у `/plugins` в REPL). */
function printList(manager: PluginManager, all: boolean): void {
  const lines = pluginListLines(
    manager.getRecords(),
    manager.getFailures(),
    all,
    readMmaVersion(),
  );
  for (const line of lines) getDefaultChannel().writeLine(line);
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
        fail(t("cli.plugins.not_found", { name }));
        return;
      }
      for (const line of formatPluginDetails(
        record,
        pluginManager.getFailures(),
        pluginManager.getToolConflicts(),
      )) {
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

  pluginsCmd
    .command("drafts")
    .description(t("cli.plugins.drafts"))
    .argument("[action]", t("cli.plugins.drafts_action"), "")
    .action(async (action: string) => {
      const { draftHost, pluginManager } = await bootstrap();
      const channel = getDefaultChannel();
      const state = draftHost.state();
      if (action === "approve") {
        draftHost.approve();
        const report = draftHost.reloadDrafts();
        channel.writeLine(
          t("cli.plugins.drafts_approved", {
            loaded: String(report.loaded),
            failed: String(report.failed),
          }),
        );
        if (report.failed > 0) {
          const dir = draftsDir(draftHost.baseDir);
          for (const f of pluginManager.getFailures().filter((x) => x.path.startsWith(dir))) {
            channel.writeLine(pc.dim(`  ✗ ${f.entry}: ${f.message}`), "stderr");
          }
        }
        return;
      }
      if (action === "revoke") {
        draftHost.revoke();
        channel.writeLine(t("cli.plugins.drafts_revoked"));
        return;
      }
      if (state.drafts.length === 0) {
        channel.writeLine(t("cli.plugins.drafts_none"));
        return;
      }
      channel.writeLine(
        t("cli.plugins.drafts_header", {
          count: String(state.drafts.length),
          approved: state.approved ? t("cli.plugins.on") : t("cli.plugins.off"),
        }),
      );
for (const draft of state.drafts) {
        const mark = state.loaded.includes(draft.name) ? ` · ${t("cli.plugins.drafts_loaded_mark")}` : "";
        channel.writeLine(`  ◇ ${draft.name}${mark}`);
      }
      channel.writeLine(pc.dim(t("cli.plugins.drafts_hint")));
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
          fail(t("cli.plugins.not_found", { name: pluginName }));
          return;
        }
        // Единый путь записи: setConfigValue сам применит deny-list к живому
        // реестру (шов в registry.ts) — и CLI, и REPL, и веб идут через него.
        const current = new Set(config.plugins?.disabled ?? []);
        if (on) current.delete(pluginName);
        else current.add(pluginName);
        const result = setConfigValue(config, "plugins.disabled", [...current].join(","));
        if (!result.ok) {
          fail(t("config.invalid_value", { key: "plugins.disabled" }));
          return;
        }
        saveConfig(config, join(configDir, "config.json"), configDir);
        channel.writeLine(`${pluginName}  ${on ? t("cli.plugins.on") : t("cli.plugins.off")}`);
      });
  }
}
