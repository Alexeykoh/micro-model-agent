import { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { runSetup } from "./setup";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { createSecurityCommand } from "./security-commands";
import { createPluginCommand } from "./plugin-commands";
import { HOSTED_BASE_URLS } from "../modules/providers/presets";
import { fileURLToPath } from "url";
import { readMmaVersion } from "../core/version";

const version = readMmaVersion();

export function createProgram(): Command {
  const program = new Command()
    .name("mma")
    .description(t("cli.description"))
    .version(version)
    .option("--no-agents-md", t("cli.no_agents_md"))
    .option("-d, --dir <path>", t("cli.dir"))
    .option("-e, --exit-on-complete", t("cli.exit_on_complete"))
    .option("-j, --json", t("cli.json"));

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
      // Apply security settings from wizard.
      // Security is enabled by default (balanced); wizard answers only tighten it.
      if (config.security) {
        config.security.enabled = true;
        config.security.bash.enabled = true;
        config.security.bash.blockDangerousFlags =
          answers.securityFlagsBlock || config.security.bash.blockDangerousFlags;
        if (answers.securityBashBlock) {
          config.security.bash.blacklist = [
            ...new Set([
              ...config.security.bash.blacklist,
              "rm",
              "dd",
              "chmod",
              "wget",
              "curl",
              "scp",
              "ssh",
              "nc",
              "netcat",
              "sudo",
              "su",
              "kill",
              "pkill",
              "killall",
              "shutdown",
              "reboot",
            ]),
          ];
        }
        if (!answers.securityPathsDeny) {
          config.security.paths.denied = [];
        }
      }
      saveConfig(config, configPath);
      console.log(t("cli.config_saved"));
    });

  const configCmd = program.command("config").description(t("cli.manage_config"));
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

      // Fetch available models from provider
      const { createProvider } = await import("../modules/providers/create");
      const provider = createProvider(config.provider.type, {
        model: config.model,
        baseUrl: config.provider.baseUrl,
        apiKey: config.provider.apiKey,
        contextWindow: config.contextWindow,
      });

      const spinner = (await import("../ui/spinner")).Spinner;
      const s = new spinner();
      s.start(t("cli.fetching_models"));
      try {
        const models = await provider.listModels();
        s.stop();
        if (models.length > 0) {
          console.log(t("cli.available_models"));
          const { getCertMark } = await import("../modules/certification/manifest");
          for (const m of models) {
            const marker = m === config.model ? "* " : "  ";
            const mark = getCertMark(m, config.provider.baseUrl, version);
            const cert = mark === "certified" ? "✔" : mark === "stale" ? "○" : "·";
            console.log(` ${marker}${cert} ${m}`);
          }
        } else {
          console.log(t("cli.no_models_found"));
        }
      } catch (err) {
        s.stop();
        console.log(t("cli.model_fetch_failed", { error: String(err) }));
      }

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
  model
    .command("certify")
    .argument("<name>", "Model name")
    .option("--provider-url <url>", t("cli.cert_provider_url"))
    .option("--provider-key <key>", t("cli.cert_provider_key"))
    .option("--context-window <n>", t("cli.cert_context_window"))
    .option("--tags <tags>", t("cli.cert_tags"), "core")
    .option("--reps <n>", t("cli.cert_reps"))
    .option("--force", t("cli.cert_force"))
    .option("--clean", t("cli.cert_clean"))
    .description(t("cli.certify"))
    .action(async (name: string, cmdOpts: any) => {
      const { config } = await bootstrap();
      const { certify, parseTags } = await import("../modules/certification/cli");
      await certify({
        name,
        providerUrl: cmdOpts.providerUrl,
        providerKey: cmdOpts.providerKey,
        contextWindow: cmdOpts.contextWindow ? parseInt(cmdOpts.contextWindow, 10) : undefined,
        tags: parseTags(cmdOpts.tags),
        reps: cmdOpts.reps ? parseInt(cmdOpts.reps, 10) : 3,
        force: cmdOpts.force === true,
        clean: cmdOpts.clean === true,
        config,
      });
    });
  model
    .command("cert-status")
    .argument("<name>", "Model name")
    .description(t("cli.cert_status"))
    .action(async (name: string) => {
      const { config } = await bootstrap();
      const { certStatus } = await import("../modules/certification/cli");
      await certStatus(name, config);
    });
  model
    .command("cert-list")
    .description(t("cli.cert_list"))
    .action(async () => {
      const { certList } = await import("../modules/certification/cli");
      await certList();
    });
  model
    .command("uncertify")
    .argument("<name>", "Model name")
    .description(t("cli.cert_uncertify"))
    .action(async (name: string) => {
      const { config } = await bootstrap();
      const { uncertify } = await import("../modules/certification/cli");
      await uncertify(name, config);
    });

  // Context window command
  program
    .command("context")
    .description(t("cli.manage_context"))
    .argument("<size>", "Context window size in tokens")
    .action(async (size: string) => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config } = await bootstrap();
      const contextWindow = parseInt(size, 10);
      if (isNaN(contextWindow) || contextWindow < 1024) {
        console.log(t("cli.invalid_context_size"));
        return;
      }
      config.contextWindow = contextWindow;
      saveConfig(config, configPath);
      console.log(t("cli.context_set", { size: contextWindow }));
    });

  const provider = program.command("provider").description(t("cli.manage_providers"));
  provider
    .command("list")
    .description(t("cli.list_providers"))
    .action(async () => {
      const { config, agent } = await bootstrap();
      const providers = agent.listProviders();
      if (providers.length > 0) {
        console.log(t("cli.current_provider"));
        for (const p of providers) {
          const marker = p.active ? pc.green("* ") : "  ";
          const prio =
            p.priority !== undefined ? `  ${pc.dim(`prio=${p.priority}`)}` : "";
          console.log(
            ` ${marker}${p.label}  (${pc.dim(p.type)})  ${pc.dim(p.baseUrl)}${prio}`,
          );
        }
        return;
      }
      console.log(t("cli.current_provider"), config.provider.type);
      console.log(t("cli.base_url"), config.provider.baseUrl);
    });
  provider
    .command("use")
    .argument("<name>", "Provider name")
    .description(t("cli.set_provider"))
    .action(async (name: string) => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config, agent } = await bootstrap();
      if (config.provider.entries && config.provider.entries.length > 0) {
        try {
          await agent.setProvider(name);
          console.log(t("cli.provider_set", { name }));
        } catch (e: any) {
          console.log(pc.red(e.message));
        }
        return;
      }
      config.provider.type = name;
      const baseUrl = HOSTED_BASE_URLS[name];
      if (baseUrl) {
        config.provider.baseUrl = baseUrl;
      }
      saveConfig(config, configPath);
      console.log(t("cli.provider_set", { name }));
      if (baseUrl) {
        console.log(t("cli.provider_base_hint", { baseUrl }));
      }
    });
  provider
    .command("add")
    .argument("<name>", "Provider type or label")
    .option("--url <url>", "Base URL")
    .option("--key <key>", "API key")
    .option("--priority <n>", "Fallback priority (lower = tried first)")
    .option("--context-window <n>", "Context window override for this entry")
    .option("--rpm <n>", "Max requests per minute for this entry")
    .option("--parallel <n>", "Max parallel tasks for this entry")
    .description(t("cli.add_provider"))
    .action(
      async (
        name: string,
        opts: {
          url?: string;
          key?: string;
          priority?: string;
          contextWindow?: string;
          rpm?: string;
          parallel?: string;
        },
      ) => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config } = await bootstrap();
      const entries = Array.isArray(config.provider.entries)
        ? config.provider.entries
        : [];
      // If a legacy single provider exists, seed the list with it first.
      if (entries.length === 0) {
        entries.push({
          type: config.provider.type,
          label: config.provider.type,
          baseUrl: config.provider.baseUrl,
          apiKey: config.provider.apiKey,
        });
      }
      const baseUrl = opts.url || HOSTED_BASE_URLS[name] || HOSTED_BASE_URLS[`opencode-${name}`] || "";
      if (!baseUrl) {
        console.log(pc.red(t("cli.provider_no_url", { name })));
        return;
      }
      entries.push({
        type: name,
        label: name,
        baseUrl,
        apiKey: opts.key,
        ...(opts.priority !== undefined ? { priority: Number(opts.priority) } : {}),
        ...(opts.contextWindow !== undefined
          ? { contextWindow: Number(opts.contextWindow) }
          : {}),
        ...(opts.rpm !== undefined || opts.parallel !== undefined
          ? {
              rateLimits: {
                maxRequestsPerMinute: Number(opts.rpm ?? 0) || 60,
                maxParallelTasks: Number(opts.parallel ?? 0) || 1,
              },
            }
          : {}),
      });
      config.provider.entries = entries;
      config.provider.active = config.provider.active || config.provider.type;
      saveConfig(config, configPath);
      console.log(pc.green(t("cli.provider_added", { name })));
      console.log(t("cli.provider_switch_hint"));
      },
    );

  const session = program.command("session").description(t("cli.manage_sessions"));
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

  // Add security commands
  createSecurityCommand(program);

  // Add plugin commands
  createPluginCommand(program);

  program
    .argument("[prompt...]", "Prompt to execute")
    .description("Run a single prompt")
    .action((prompt: string[]) => {
      /* Handled by main.ts after program.parse() */
    });

  return program;
}
