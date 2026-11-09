// Команды моделей: list/use/certify/cert-status/cert-list/uncertify.
import type { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { dirname } from "path";
import { getDefaultChannel } from "../output";
import { globalConfigFile } from "../config/paths";
import { readMmaVersion } from "../core/version";

const version = readMmaVersion();

export function buildModelCommands(program: Command): void {
  const model = program.command("model").description(t("cli.manage_models"));
  model
    .command("list")
    .description(t("cli.list_models"))
    .action(async () => {
      const { config } = await bootstrap();
      getDefaultChannel().writeLine(`${t("cli.current_model")} ${config.model}`);

      // Тянем доступные модели с провайдера.
      const { createProvider } = await import("../modules/providers/create");
      const { activeProviderEndpoint } = await import("../modules/providers/manager");
      const endpoint = activeProviderEndpoint(config.provider);
      const provider = createProvider(endpoint.type, {
        model: config.model,
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        contextWindow: config.contextWindow,
      });

      const spinner = (await import("../ui/spinner")).Spinner;
      const s = new spinner();
      s.start(t("cli.fetching_models"));
      try {
        const models = await provider.listModels();
        s.stop();
        if (models.length > 0) {
          getDefaultChannel().writeLine(t("cli.available_models"));
          const { getCertMark } = await import("../modules/certification/manifest");
          for (const m of models) {
            const marker = m === config.model ? "* " : "  ";
            const mark = getCertMark(m, config.provider.baseUrl, version, process.cwd());
            const cert = mark === "certified" ? "✔" : mark === "stale" ? "○" : "·";
            const label =
              mark === "certified"
                ? `  ${pc.green(t("cli.cert_label"))}`
                : mark === "stale"
                  ? `  ${pc.yellow(t("cli.cert_stale_label"))}`
                  : "";
            getDefaultChannel().writeLine(` ${marker}${cert} ${m}${label}`);
          }
        } else {
          getDefaultChannel().writeLine(t("cli.no_models_found"));
        }
      } catch (err) {
        s.stop();
        getDefaultChannel().writeLine(t("cli.model_fetch_failed", { error: String(err) }));
      }

      // CLI-форма команды, а не REPL-форма `/model use` (ключ общий с REPL).
      getDefaultChannel().writeLine(t("cli.model_hint_cli"));
    });
  model
    .command("use")
    .argument("<name>", t("cli.model_name"))
    .description(t("cli.set_model"))
    .action(async (name: string) => {
      const configPath = globalConfigFile();
      const { config } = await bootstrap();
      config.model = name;
      saveConfig(config, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.model_set", { name }));
    });
  model
    .command("certify")
    .argument("<name>", t("cli.model_name"))
    .option("--provider-url <url>", t("cli.cert_provider_url"))
    .option("--provider-key <key>", t("cli.cert_provider_key"))
    .option("--context-window <n>", t("cli.cert_context_window"))
    .option("--tags <tags>", t("cli.cert_tags"), "core")
    .option("--scenarios <ids>", t("cli.cert_scenarios"))
    .option("--timeout <ms>", t("cli.cert_timeout"))
    .option("--reps <n>", t("cli.cert_reps"))
    .option("--force", t("cli.cert_force"))
    .option("--clean", t("cli.cert_clean"))
    .description(t("cli.certify"))
    .action(async (name: string, cmdOpts: {
      providerUrl?: string;
      providerKey?: string;
      contextWindow?: string;
      tags?: string;
      scenarios?: string;
      timeout?: string;
      reps?: string;
      force?: boolean;
      clean?: boolean;
    }) => {
      const { config } = await bootstrap();
      const { certify, parseTags } = await import("../modules/certification/cli");
      await certify({
        name,
        providerUrl: cmdOpts.providerUrl,
        providerKey: cmdOpts.providerKey,
        contextWindow: cmdOpts.contextWindow ? parseInt(cmdOpts.contextWindow, 10) : undefined,
        tags: parseTags(cmdOpts.tags ?? "core"),
        scenarios: cmdOpts.scenarios
          ? String(cmdOpts.scenarios)
              .split(",")
              .map((x: string) => x.trim())
              .filter(Boolean)
          : undefined,
        reps: cmdOpts.reps ? parseInt(cmdOpts.reps, 10) : 3,
        timeout: cmdOpts.timeout ? parseInt(cmdOpts.timeout, 10) : undefined,
        force: cmdOpts.force === true,
        clean: cmdOpts.clean === true,
        config,
        projectDir: process.cwd(),
      });
    });
  model
    .command("cert-status")
    .argument("<name>", t("cli.model_name"))
    .description(t("cli.cert_status"))
    .action(async (name: string) => {
      const { config } = await bootstrap();
      const { certStatus } = await import("../modules/certification/cli");
      await certStatus(name, config, process.cwd());
    });
  model
    .command("cert-list")
    .description(t("cli.cert_list"))
    .action(async () => {
      const { certList } = await import("../modules/certification/cli");
      await certList(process.cwd());
    });
  model
    .command("uncertify")
    .argument("<name>", t("cli.model_name"))
    .description(t("cli.cert_uncertify"))
    .action(async (name: string) => {
      const { config } = await bootstrap();
      const { uncertify } = await import("../modules/certification/cli");
      await uncertify(name, config, process.cwd());
    });
}
