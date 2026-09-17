import { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { runSetup } from "./setup";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { createSecurityCommand } from "./security-commands";
import { createPluginCommand } from "./plugin-commands";
import { HOSTED_BASE_URLS } from "../modules/providers/presets";
import { probeProviders, targetsFromProviders } from "../modules/providers/health";
import { readMmaVersion } from "../core/version";
import type { IndexerModule } from "../modules/indexer/module";
import { runMapAction } from "../modules/indexer/map-command";
import { budgetBreakdownLines, setBudgetShare } from "../config/budget";
import { fetchProviderBudget } from "../llm/provider-budget";
import { formatCost } from "../modules/pricing/prices";
import { readChangelog, extractLatestChangelog, extractChangelogRange } from "../modules/updater/changelog-reader";

const version = readMmaVersion();

function buildInitCommand(program: Command): void {
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
      saveConfig(config, configPath, dirname(configPath));
      console.log(t("cli.config_saved"));
    });
}

function buildConfigCommands(program: Command): void {
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
      saveConfig(config, configPath, dirname(configPath));
      console.log(t("cli.set_done", { key, value }));
    });
  configCmd
    .command("show")
    .description(t("cli.show_config"))
    .action(async () => {
      const { config } = await bootstrap();
      console.log(JSON.stringify(config, null, 2));
    });
  configCmd
    .command("migrate")
    .description(t("cli.migrate_config"))
    .action(async () => {
      const { loadConfig } = await import("../config/config");
      const { hasDomainFiles } = await import("../config/domains");
      const configDir = join(homedir(), ".mma");
      const configPath = join(configDir, "config.json");

      if (hasDomainFiles(configDir)) {
        console.log(pc.yellow(t("config.migrate_no_legacy")));
        return;
      }

      if (!existsSync(configPath)) {
        console.log(pc.yellow(t("config.migrate_no_legacy")));
        return;
      }

      console.log(t("config.migrate_start"));

      const { config } = loadConfig({ configDir, projectConfigPath: join(configDir, ".mmrc") });
      saveConfig(config, configPath, configDir);

      // Rename legacy file
      const bakPath = configPath + ".bak";
      const { renameSync } = await import("fs");
      renameSync(configPath, bakPath);

      const { readdirSync } = await import("fs");
      const domainFiles = readdirSync(join(configDir, "config")).filter((f: string) => f.endsWith(".json"));
      console.log(pc.green(t("config.migrate_done", { count: String(domainFiles.length) })));
    });
}

function buildModelCommands(program: Command): void {
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
            const mark = getCertMark(m, config.provider.baseUrl, version, process.cwd());
            const cert = mark === "certified" ? "✔" : mark === "stale" ? "○" : "·";
            const label =
              mark === "certified"
                ? `  ${pc.green(t("cli.cert_label"))}`
                : mark === "stale"
                  ? `  ${pc.yellow(t("cli.cert_stale_label"))}`
                  : "";
            console.log(` ${marker}${cert} ${m}${label}`);
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
      saveConfig(config, configPath, dirname(configPath));
      console.log(t("cli.model_set", { name }));
    });
  model
    .command("certify")
    .argument("<name>", "Model name")
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
    .action(async (name: string, cmdOpts: any) => {
      const { config } = await bootstrap();
      const { certify, parseTags } = await import("../modules/certification/cli");
      await certify({
        name,
        providerUrl: cmdOpts.providerUrl,
        providerKey: cmdOpts.providerKey,
        contextWindow: cmdOpts.contextWindow ? parseInt(cmdOpts.contextWindow, 10) : undefined,
        tags: parseTags(cmdOpts.tags),
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
    .argument("<name>", "Model name")
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
    .argument("<name>", "Model name")
    .description(t("cli.cert_uncertify"))
    .action(async (name: string) => {
      const { config } = await bootstrap();
      const { uncertify } = await import("../modules/certification/cli");
      await uncertify(name, config, process.cwd());
    });
}

function buildContextCommand(program: Command): void {
  program
    .command("context")
    .description(t("cli.manage_context"))
    .argument("[size]", "Context window size in tokens (omit to show the budget breakdown)")
    .option("--system <fraction>", t("cli.context_system_fraction"))
    .option("--reserve <fraction>", t("cli.context_reserve_fraction"))
    .action(async (size: string | undefined, opts: { system?: string; reserve?: string }) => {
      const { config, configDir } = await bootstrap();
      const configPath = join(configDir, "config.json");

      if (opts.system !== undefined || opts.reserve !== undefined) {
        const key = opts.system !== undefined ? "system" : "reserve";
        const value = Number(opts.system ?? opts.reserve);
        if (setBudgetShare(config, key, value) !== null) {
          console.log(t("cli.context_invalid_fraction"));
          return;
        }
        saveConfig(config, configPath, dirname(configPath));
        console.log(t("cli.context_fraction_set", { key, value }));
        return;
      }

      if (size === undefined) {
        for (const line of budgetBreakdownLines(config)) console.log(line);
        return;
      }

      const contextWindow = parseInt(size, 10);
      if (isNaN(contextWindow) || contextWindow < 1024) {
        console.log(t("cli.invalid_context_size"));
        return;
      }
      config.contextWindow = contextWindow;
      saveConfig(config, configPath, dirname(configPath));
      console.log(t("cli.context_set", { size: contextWindow }));
    });
}

function buildUsageCommand(program: Command): void {
  program
    .command("usage")
    .description(t("cli.usage"))
    .action(async () => {
      const { config, logger } = await bootstrap();
      const { type: provider, baseUrl, apiKey } = config.provider;
      const result = await fetchProviderBudget(provider, baseUrl, apiKey, {
        log: (level, message) =>
          level === "warn" ? logger.warn(message) : logger.debug(message),
      });

      if (result.reason === "unsupported") {
        console.log(t("cli.usage_unsupported", { provider }));
        return;
      }
      if (result.reason === "no-key") {
        console.log(t("cli.usage_no_key"));
        return;
      }
      if (result.reason === "error" || !result.budget) {
        console.log(t("cli.usage_error", { error: result.error ?? "" }));
        return;
      }

      const b = result.budget;
      let printed = false;
      if (b.keyUsageUsd !== undefined) {
        console.log(t("cli.usage_key_usage", { usage: formatCost(b.keyUsageUsd) }));
        printed = true;
      }
      if (b.keyLimitUsd !== undefined && b.keyRemainingUsd !== undefined) {
        console.log(
          t("cli.usage_key_limit", {
            limit: formatCost(b.keyLimitUsd),
            remaining: formatCost(b.keyRemainingUsd),
          }),
        );
        printed = true;
      }
      if (b.balanceUsd !== undefined) {
        console.log(t("cli.usage_balance", { balance: formatCost(b.balanceUsd) }));
        printed = true;
      }
      if (b.totalCreditsUsd !== undefined && b.totalUsageUsd !== undefined) {
        console.log(
          t("cli.usage_account", {
            credits: formatCost(b.totalCreditsUsd),
            used: formatCost(b.totalUsageUsd),
          }),
        );
        printed = true;
      }
      if (!printed) console.log(t("cli.usage_empty"));
    });
}

function buildMapCommand(program: Command): void {
  program
    .command("map")
    .description(t("cli.map.description"))
    .argument("[action]", t("cli.map.action"), "summary")
    .argument("[query]", t("cli.map.query"))
    .action(async (action: string, query?: string) => {
      const { agent } = await bootstrap();
      const indexer = agent.getModule<IndexerModule>("indexer");
      if (!indexer) {
        console.log(t("indexer.not_indexed"));
        return;
      }
      const result = await runMapAction(indexer, action, query);
      console.log(result.output);
    });
}

function buildProviderCommands(program: Command): void {
  const provider = program.command("provider").description(t("cli.manage_providers"));
  provider
    .command("check")
    .description(t("cli.provider_check"))
    .option("--timeout <ms>", "Per-provider probe timeout in ms")
    .action(async (opts: { timeout?: string }) => {
      const { config, agent } = await bootstrap();
      const providers = agent.listProviders();
      const targets = targetsFromProviders(
        providers.length > 0
          ? providers
              .map((p) => ({ name: p.label, provider: agent.getProviderFor(p.label) }))
              .filter((x): x is { name: string; provider: NonNullable<typeof x.provider> } =>
                Boolean(x.provider),
              )
          : [
              {
                name: config.provider.type,
                provider: agent.getProviderFor(
                  config.provider.active || config.provider.type,
                ),
              },
            ].filter((x): x is { name: string; provider: NonNullable<typeof x.provider> } =>
              Boolean(x.provider),
            ),
      );
      const results = await probeProviders(targets, {
        timeoutMs: opts.timeout ? Number(opts.timeout) : 5000,
      });
      for (const r of results) {
        const mark = r.ok ? pc.green("✓") : pc.red("✗");
        const detail = r.ok
          ? pc.dim(`${r.ms}ms, ${r.models} models`)
          : pc.red(r.error ?? "failed");
        console.log(` ${mark} ${r.name.padEnd(16)} ${detail}`);
      }
    });
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
      saveConfig(config, configPath, dirname(configPath));
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
      saveConfig(config, configPath, dirname(configPath));
      console.log(pc.green(t("cli.provider_added", { name })));
      console.log(t("cli.provider_switch_hint"));
      },
    );
}

function buildSessionCommands(program: Command): void {
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

      const moeEvents = sessionManager.loadSessionLog(id).filter((e) => e.type.startsWith("moe_"));
      if (moeEvents.length > 0) {
        console.log("");
        console.log(pc.cyan("MoE events:"));
        for (const e of moeEvents) {
          const ts = e.ts.slice(11, 19);
          if (e.type === "moe_subtask") {
            console.log(
              `  ${pc.dim(ts)} [subtask] ${e.subtaskId} (${e.expertTag}) ${e.status ?? ""}${
                e.durationMs !== undefined ? ` ${e.durationMs}ms` : ""
              }`,
            );
          } else if (e.type === "moe_plan") {
            console.log(
              `  ${pc.dim(ts)} [plan] ${e.status === "ok" ? e.subtaskIds?.join(", ") : e.status}`,
            );
          } else if (e.type === "moe_replan") {
            console.log(`  ${pc.dim(ts)} [replan] cycle ${e.cycle}: ${e.subtaskIds?.join(", ")}`);
          } else {
            const usage = e.usageByTag
              ? " | usage: " +
                Object.entries(e.usageByTag)
                  .map(([tag, u]) => `${tag}=${u.totalTokens}t`)
                  .join(", ")
              : "";
            console.log(
              `  ${pc.dim(ts)} [verify] ${e.decision ?? e.status ?? "?"}${
                e.explanation ? ` — ${e.explanation}` : ""
              }${usage}`,
            );
          }
        }
      }

      const usageEvents = sessionManager.loadSessionLog(id).filter((e) => e.type === "llm_usage");
      if (usageEvents.length > 0) {
        let prompt = 0;
        let completion = 0;
        let cached = 0;
        for (const e of usageEvents) {
          prompt += e.promptTokens ?? 0;
          completion += e.completionTokens ?? 0;
          cached += e.cachedTokens ?? 0;
        }
        console.log("");
        console.log(
          pc.cyan(
            t("cli.session_usage", {
              prompt,
              completion,
              total: prompt + completion,
            }),
          ),
        );
        if (cached > 0 && prompt > 0) {
          const hit = Math.round((cached / prompt) * 100);
          console.log(
            pc.dim(
              t("cli.session_cache", {
                hit,
                cached,
                uncached: Math.max(0, prompt - cached),
              }),
            ),
          );
        }
      }
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
}

function buildChangelogCommand(program: Command): void {
  program
    .command("changelog")
    .description(t("cli.changelog_title", { version }))
    .option("--from <version>", t("cli.changelog_range", { from: "..." }))
    .action((opts: { from?: string }) => {
      const changelog = readChangelog("micro-models-agent");
      if (!changelog) {
        console.log(pc.yellow(t("cli.changelog_not_found")));
        return;
      }
      if (opts.from) {
        const range = extractChangelogRange(changelog, opts.from, version);
        if (!range) {
          console.log(pc.yellow(t("cli.changelog_not_found")));
          return;
        }
        console.log(pc.cyan(t("cli.changelog_range", { from: opts.from })));
        console.log(range);
      } else {
        const latest = extractLatestChangelog(changelog);
        if (!latest) {
          console.log(pc.yellow(t("cli.changelog_not_found")));
          return;
        }
        console.log(pc.cyan(t("cli.changelog_title", { version })));
        console.log(latest);
      }
    });
}

/** Тонкий оркестратор: собирает CLI из per-domain builder-функций. */
export function createProgram(): Command {
  const program = new Command()
    .name("mma")
    .description(t("cli.description"))
    .version(version)
    .option("--no-agents-md", t("cli.no_agents_md"))
    .option("-d, --dir <path>", t("cli.dir"))
    .option("-e, --exit-on-complete", t("cli.exit_on_complete"))
    .option("-j, --json", t("cli.json"))
    .option("--reasoning <level>", t("cli.reasoning_level"), "auto");

  buildInitCommand(program);
  buildConfigCommands(program);
  buildModelCommands(program);
  buildContextCommand(program);
  buildUsageCommand(program);
  buildMapCommand(program);
  buildProviderCommands(program);
  buildSessionCommands(program);

  // Add security commands
  createSecurityCommand(program);

  // Add plugin commands
  createPluginCommand(program);

  buildChangelogCommand(program);

  program
    .argument("[prompt...]", "Prompt to execute")
    .description("Run a single prompt")
    .action((prompt: string[]) => {
      /* Handled by main.ts after program.parse() */
    });

  // Subcommand actions run full bootstrap() (reasoning-probe fetch, indexer,
  // plugins…), which leaves open handles — without an explicit exit the
  // process hangs after printing its result ("config set" printed, never
  // exited). The prompt/REPL paths exit explicitly in main.ts; every
  // SUBCOMMAND is one-shot, so exit as soon as its action resolves.
  //
  // Хук навешиваем РЕКУРСИВНО на все подкоманды (не только верхнего уровня):
  // у вложенных (`session show`, `model certify`, `provider use` …) родитель
  // без action, поэтому postAction родителя не срабатывает, и фоновые хендлы
  // bootstrap держат процесс — команда «виснет» после вывода. На `program`
  // хук не вешаем: его action — prompt/REPL, которым управляет main.ts.
  const attachOneShotExit = (cmd: Command): void => {
    cmd.hook("postAction", () => {
      process.exit(0);
    });
    for (const sub of cmd.commands) attachOneShotExit(sub);
  };
  for (const cmd of program.commands) attachOneShotExit(cmd);

  return program;
}