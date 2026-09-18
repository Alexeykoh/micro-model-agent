import { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { readMmaVersion } from "../core/version";
import { t } from "../i18n/index";
import { getDefaultChannel } from "../output";

/**
 * Create the `mma plugins` subcommand group.
 */
export function createPluginCommand(program: Command): void {
  const pluginsCmd = program.command("plugins").description(t("cli.plugins.description"));

  pluginsCmd
    .command("list")
    .description(t("cli.plugins.list"))
    .option("-a, --all", t("cli.plugins.all"))
    .action(async (cmdOpts: { all?: boolean }) => {
      const { pluginManager } = await bootstrap();
      const all = cmdOpts.all === true;
      let infos = pluginManager.getPluginInfos();
      if (!all) {
        infos = infos.filter(({ plugin }) => !plugin.isBuiltin);
      }
      if (infos.length === 0) {
        getDefaultChannel().writeLine(t("cli.plugins.none"));
        return;
      }
      const mmaVersion = readMmaVersion();
      getDefaultChannel().writeLine(
        t("cli.plugins.header", { count: String(infos.length), mma: mmaVersion }),
      );
      for (const { plugin, source } of infos) {
        const version = plugin.version || "-";
        const origin = source || "builtin";
        const builtin = plugin.isBuiltin ? t("cli.plugins.builtin_mark") : " ";
        getDefaultChannel().writeLine(`  ${builtin} ${plugin.name}  v${version}  [${origin}]`);
      }
      if (!all) {
        getDefaultChannel().writeLine(t("cli.plugins.only_external"));
      }
    });
}
