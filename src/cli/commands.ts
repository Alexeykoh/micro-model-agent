import { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { runSetup } from "./setup";
import { t } from "../i18n/index";
import { join } from "path";
import { homedir } from "os";

export function createProgram(): Command {
  const program = new Command()
    .name("mma")
    .description(t("cli.description"))
    .version("0.4.0")
    .option("--no-agents-md", t("cli.no_agents_md"))
    .option("-d, --dir <path>", t("cli.dir"))
    .option("-e, --exit-on-complete", t("cli.exit_on_complete"));

  program
    .command("init")
    .description(t("cli.init"))
    .action(async () => {
      const answers = await runSetup();
      const configPath = join(homedir(), ".mma", "config.json");
      const { config } = await bootstrap();
      config.provider.type = answers.provider;
      config.provider.baseUrl = answers.apiBase;
      config.provider.apiKey = answers.apiKey;
      config.model = answers.model;
      config.contextWindow = answers.contextWindow;
      config.maxToolIterations = answers.maxToolIterations;
      config.locale = answers.locale;
      saveConfig(config, configPath);
      console.log(t("cli.config_saved"));
    });

  const configCmd = program
    .command("config")
    .description(t("cli.manage_config"));
  configCmd
    .command("set")
    .argument("<key>", t("cli.config_key"))
    .argument("<value>", "Config value")
    .description(t("cli.set_value"))
    .action(async (key: string, value: string) => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config } = await bootstrap();
      const keys = key.split(".");
      let obj: any = config;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in obj)) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      const lastKey = keys[keys.length - 1];
      if (value === "true") obj[lastKey] = true;
      else if (value === "false") obj[lastKey] = false;
      else if (/^\d+$/.test(value)) obj[lastKey] = parseInt(value, 10);
      else if (/^\d+\.\d+$/.test(value)) obj[lastKey] = parseFloat(value);
      else obj[lastKey] = value;
      saveConfig(config, configPath);
      console.log(t("cli.set_done", { key, value }));
    });
  configCmd
    .command("show")
    .description(t("cli.show_config"))
    .action(async () => {
      const { config } = await bootstrap();
      console.log(JSON.stringify(config, null, 2));
    });

  const model = program.command("model").description(t("cli.manage_models"));
  model
    .command("list")
    .description(t("cli.list_models"))
    .action(async () => {
      const { config } = await bootstrap();
      console.log(t("cli.current_model"), config.model);
      console.log(t("cli.model_hint"));
    });
  model
    .command("use")
    .argument("<name>", "Model name")
    .description(t("cli.set_model"))
    .action(async (name: string) => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config } = await bootstrap();
      config.model = name;
      saveConfig(config, configPath);
      console.log(t("cli.model_set", { name }));
    });

  const provider = program
    .command("provider")
    .description(t("cli.manage_providers"));
  provider
    .command("list")
    .description(t("cli.list_providers"))
    .action(async () => {
      const { config } = await bootstrap();
      console.log(t("cli.current_provider"), config.provider.type);
      console.log(t("cli.base_url"), config.provider.baseUrl);
    });
  provider
    .command("use")
    .argument("<name>", "Provider name")
    .description(t("cli.set_provider"))
    .action(async (name: string) => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config } = await bootstrap();
      config.provider.type = name;
      saveConfig(config, configPath);
      console.log(t("cli.provider_set", { name }));
    });

  const session = program
    .command("session")
    .description(t("cli.manage_sessions"));
  session
    .command("list")
    .description(t("cli.list_sessions"))
    .action(async () => {
      const { sessionManager } = await bootstrap();
      const sessions = sessionManager.list();
      if (sessions.length === 0) {
        console.log(t("session.no_sessions"));
        return;
      }
      const active = sessionManager.getActive();
      for (const s of sessions) {
        const marker = s.id === active ? "*" : " ";
        console.log(
          ` ${marker} ${s.id.slice(0, 12)}  ${s.name}  ${s.messageCount} msgs  ${s.updatedAt.slice(0, 10)}`,
        );
      }
    });
  session
    .command("show")
    .argument("<id>", "Session id")
    .description(t("cli.show_details"))
    .action(async (id: string) => {
      const { sessionManager } = await bootstrap();
      const meta = sessionManager.get(id);
      if (!meta) {
        console.log(t("session.not_found", { id }));
        return;
      }
      console.log(`ID:           ${meta.id}`);
      console.log(`Name:         ${meta.name}`);
      console.log(`Created:      ${meta.createdAt}`);
      console.log(`Updated:      ${meta.updatedAt}`);
      console.log(`Messages:     ${meta.messageCount}`);
      console.log(`Model:        ${meta.model}`);
      console.log(`Context:      ${meta.contextWindow}`);
      console.log(`Project:      ${meta.projectDir}`);
    });
  session
    .command("delete")
    .argument("<id>", "Session id")
    .description(t("cli.delete_session"))
    .action(async (id: string) => {
      const { sessionManager } = await bootstrap();
      sessionManager.delete(id);
      console.log(t("session.deleted", { id }));
    });

  program
    .argument("[prompt...]", "Prompt to execute")
    .description("Run a single prompt")
    .action((prompt: string[]) => {
      /* Handled by main.ts after program.parse() */
    });

  return program;
}
