// Команды запуска поверхности: setup/meet/init/web/serve/agents.
import type { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { runSetup } from "./setup";
import { applyAnswersToConfig } from "./setup-order";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { dirname } from "path";
import { getDefaultChannel } from "../output";
import { globalConfigFile } from "../config/paths";

/** Общее тело визарда настройки провайдера (`mma setup` и устаревший `mma init`). */
async function runWizardCommand(): Promise<void> {
  const answers = await runSetup();
  const configPath = globalConfigFile();
  const { config } = await bootstrap();
  applyAnswersToConfig(config, answers);
  saveConfig(config, configPath, dirname(configPath));
  getDefaultChannel().writeLine(t("cli.config_saved"));
}

export function buildSetupCommand(program: Command): void {
  program.command("setup").description(t("cli.setup")).action(runWizardCommand);
}

export function buildMeetCommand(program: Command): void {
  program
    .command("meet")
    .description(t("cli.meet"))
    .action(() => {});
}

export function buildInitCommand(program: Command): void {
  program
    .command("init")
    .description(t("cli.init"))
    .action(async () => {
      getDefaultChannel().writeLine(pc.yellow(t("cli.init_deprecated")));
      await runWizardCommand();
    });
}

export function buildWebCommand(program: Command): void {
  program
    .command("web")
    .description(t("cli.web.description"))
    .option("-p, --port <n>", t("cli.web.port"))
    .option("--host <addr>", t("cli.web.host"))
    .option("--token <t>", t("cli.web.token"))
    .option("--no-open", t("cli.web.no_open"))
    .option("--daemon-url <url>", t("cli.web.daemon"))
    .action(() => {
      /* Диспатчится из main.ts после program.parse(): веб-сервер долгоживущий,
         хук one-shot выхода его резать не должен. */
    });
}

export function buildServeCommand(program: Command): void {
  program
    .command("serve")
    .description(t("cli.serve.description"))
    .option("-p, --port <n>", t("cli.serve.port"))
    .option("--host <addr>", t("cli.serve.host"))
    .option("--token <t>", t("cli.serve.token"))
    .action(() => {
      /* Диспатчится из main.ts после program.parse(): сервис долгоживущий,
         хук one-shot выхода его резать не должен. */
    });
}

export function buildAgentsCommand(program: Command): void {
  const agents = program.command("agents").description(t("cli.agents"));
  agents
    .command("init")
    .description(t("cli.agents_init"))
    .action(() => {});
}
