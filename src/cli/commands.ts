// Commander-программа: setup/meet/init/web/agents/config/session/* и фабрика createProgram.
import { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { runSetup } from "./setup";
import { applyAnswersToConfig } from "./setup-order";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import {
  formatExport,
  redactExport,
  sanitizeFileName,
  extensionFor,
  type ExportFormat,
} from "../modules/session/export";
import { createSecurityCommand } from "./security-commands";
import { createPluginCommand } from "./plugin-commands";
import { HOSTED_BASE_URLS } from "../modules/providers/presets";
import { providerNameTaken } from "../modules/providers/naming";
import { probeProviders, targetsFromProviders } from "../modules/providers/health";
import { readMmaVersion } from "../core/version";
import type { IndexerModule } from "../modules/indexer/module";
import { runMapAction } from "../modules/indexer/map-command";
import { budgetBreakdownLines, setBudgetShare } from "../config/budget";
import { fetchProviderBudget } from "../llm/provider-budget";
import { formatCost } from "../modules/pricing/prices";
import {
  readChangelog,
  extractLatestChangelog,
  extractChangelogRange,
} from "../modules/updater/changelog-reader";
import { getDefaultChannel, writeMachineJson } from "../output";
import { setConfigValue } from "../config/registry";
import { redactConfigSecrets } from "../config/redact";
import { MMA_DIR_NAME, globalConfigFile, globalExportsDir } from "../config/paths";

const version = readMmaVersion();

/** Конфиг для `mma config show`: секреты затёрты, если явно не просили. */
export function configForDisplay<T>(config: T, showSecrets?: boolean): T {
  return showSecrets ? config : redactConfigSecrets(config);
}

/** Общее тело визарда настройки провайдера (`mma setup` и устаревший `mma init`). */
async function runWizardCommand(): Promise<void> {
  const answers = await runSetup();
  const configPath = globalConfigFile();
  const { config } = await bootstrap();
  applyAnswersToConfig(config, answers);
  saveConfig(config, configPath, dirname(configPath));
  getDefaultChannel().writeLine(t("cli.config_saved"));
}

function buildSetupCommand(program: Command): void {
  program.command("setup").description(t("cli.setup")).action(runWizardCommand);
}

function buildMeetCommand(program: Command): void {
  program.command("meet").description(t("cli.meet")).action(() => {});
}

function buildInitCommand(program: Command): void {
  program
    .command("init")
    .description(t("cli.init"))
    .action(async () => {
      getDefaultChannel().writeLine(pc.yellow(t("cli.init_deprecated")));
      await runWizardCommand();
    });
}

function buildWebCommand(program: Command): void {
  program
    .command("web")
    .description(t("cli.web.description"))
    .option("-p, --port <n>", t("cli.web.port"))
    .option("--host <addr>", t("cli.web.host"))
    .option("--token <t>", t("cli.web.token"))
    .option("--no-open", t("cli.web.no_open"))
    .action(() => {
      /* Диспатчится из main.ts после program.parse(): веб-сервер долгоживущий,
         хук one-shot выхода его резать не должен. */
    });
}

function buildAgentsCommand(program: Command): void {
  const agents = program.command("agents").description(t("cli.agents"));
  agents
    .command("init")
    .description(t("cli.agents_init"))
    .action(() => {});
}

function buildConfigCommands(program: Command): void {
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
        getDefaultChannel().writeLine(t("cli.set_done", { key, value }));
        return;
      }
      const r = setConfigValue(config, key, value);
      if (!r.ok) {
        getDefaultChannel().writeLine(
          pc.yellow(t("cli.config_invalid", { key: r.input, reason: r.reason })),
          "stderr",
        );
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

function buildModelCommands(program: Command): void {
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

      getDefaultChannel().writeLine(t("cli.model_hint"));
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

function buildContextCommand(program: Command): void {
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
          getDefaultChannel().writeLine(t("cli.context_invalid_fraction"));
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
        getDefaultChannel().writeLine(t("cli.invalid_context_size"));
        return;
      }
      config.contextWindow = contextWindow;
      saveConfig(config, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.context_set", { size: contextWindow }));
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
        log: (level, message) => (level === "warn" ? logger.warn(message) : logger.debug(message)),
      });

      if (result.reason === "unsupported") {
        getDefaultChannel().writeLine(t("cli.usage_unsupported", { provider }));
        return;
      }
      if (result.reason === "no-key") {
        getDefaultChannel().writeLine(t("cli.usage_no_key"));
        return;
      }
      if (result.reason === "error" || !result.budget) {
        getDefaultChannel().writeLine(t("cli.usage_error", { error: result.error ?? "" }));
        return;
      }

      const b = result.budget;
      let printed = false;
      if (b.keyUsageUsd !== undefined) {
        getDefaultChannel().writeLine(
          t("cli.usage_key_usage", { usage: formatCost(b.keyUsageUsd) }),
        );
        printed = true;
      }
      if (b.keyLimitUsd !== undefined && b.keyRemainingUsd !== undefined) {
        getDefaultChannel().writeLine(
          t("cli.usage_key_limit", {
            limit: formatCost(b.keyLimitUsd),
            remaining: formatCost(b.keyRemainingUsd),
          }),
        );
        printed = true;
      }
      if (b.balanceUsd !== undefined) {
        getDefaultChannel().writeLine(
          t("cli.usage_balance", { balance: formatCost(b.balanceUsd) }),
        );
        printed = true;
      }
      if (b.totalCreditsUsd !== undefined && b.totalUsageUsd !== undefined) {
        getDefaultChannel().writeLine(
          t("cli.usage_account", {
            credits: formatCost(b.totalCreditsUsd),
            used: formatCost(b.totalUsageUsd),
          }),
        );
        printed = true;
      }
      if (!printed) getDefaultChannel().writeLine(t("cli.usage_empty"));
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
        getDefaultChannel().writeLine(t("indexer.not_indexed"));
        return;
      }
      const result = await runMapAction(indexer, action, query);
      getDefaultChannel().writeLine(result.output);
    });
}

function buildProviderCommands(program: Command): void {
  const provider = program.command("provider").description(t("cli.manage_providers"));
  provider
    .command("check")
    .description(t("cli.provider_check"))
    .option("--timeout <ms>", t("cli.probe_timeout"))
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
                provider: agent.getProviderFor(config.provider.active || config.provider.type),
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
        const detail = r.ok ? pc.dim(`${r.ms}ms, ${r.models} models`) : pc.red(r.error ?? "failed");
        getDefaultChannel().writeLine(` ${mark} ${r.name.padEnd(16)} ${detail}`);
      }
    });
  provider
    .command("list")
    .description(t("cli.list_providers"))
    .action(async () => {
      const { config, agent } = await bootstrap();
      const providers = agent.listProviders();
      if (providers.length > 0) {
        getDefaultChannel().writeLine(t("cli.current_provider"));
        for (const p of providers) {
          const marker = p.active ? pc.green("* ") : "  ";
          const prio = p.priority !== undefined ? `  ${pc.dim(`prio=${p.priority}`)}` : "";
          getDefaultChannel().writeLine(
            ` ${marker}${p.label}  (${pc.dim(p.type)})  ${pc.dim(p.baseUrl)}${prio}`,
          );
        }
        return;
      }
      getDefaultChannel().writeLine(`${t("cli.current_provider")} ${config.provider.type}`);
      getDefaultChannel().writeLine(`${t("cli.base_url")} ${config.provider.baseUrl}`);
    });
  provider
    .command("use")
    .argument("<name>", t("cli.provider_name"))
    .description(t("cli.set_provider"))
    .action(async (name: string) => {
      const configPath = globalConfigFile();
      const { config, agent } = await bootstrap();
      if (config.provider.entries && config.provider.entries.length > 0) {
        try {
          await agent.setProvider(name);
          // Персист: `agent.setProvider` мутит только in-memory конфиг, так что свитч
          // молча терялся на выходе для мульти-записных конфигов.
          saveConfig(config, configPath, dirname(configPath));
          getDefaultChannel().writeLine(t("cli.provider_set", { name }));
        } catch (e: any) {
          getDefaultChannel().writeLine(pc.red(e.message));
        }
        return;
      }
      config.provider.type = name;
      const baseUrl = HOSTED_BASE_URLS[name];
      if (baseUrl) {
        config.provider.baseUrl = baseUrl;
      }
      saveConfig(config, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.provider_set", { name }));
      if (baseUrl) {
        getDefaultChannel().writeLine(t("cli.provider_base_hint", { baseUrl }));
      }
    });
  provider
    .command("add")
    .argument("<name>", t("cli.provider_type_label"))
    .option("--url <url>", t("cli.provider_base_url"))
    .option("--key <key>", t("cli.provider_api_key"))
    .option("--priority <n>", t("cli.provider_priority"))
    .option("--context-window <n>", t("cli.provider_context_window"))
    .option("--rpm <n>", t("cli.provider_rpm"))
    .option("--parallel <n>", t("cli.provider_parallel"))
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
        const configPath = globalConfigFile();
        const { config } = await bootstrap();
        const entries = Array.isArray(config.provider.entries) ? config.provider.entries : [];
        // Есть legacy-одиночка — сидим список сначала с него.
        if (entries.length === 0) {
          entries.push({
            type: config.provider.type,
            label: config.provider.type,
            baseUrl: config.provider.baseUrl,
            apiKey: config.provider.apiKey,
          });
        }
        const baseUrl =
          opts.url || HOSTED_BASE_URLS[name] || HOSTED_BASE_URLS[`opencode-${name}`] || "";
        if (!baseUrl) {
          getDefaultChannel().writeLine(pc.red(t("cli.provider_no_url", { name })));
          return;
        }
        if (providerNameTaken(entries, name)) {
          getDefaultChannel().writeLine(pc.red(t("cli.provider_name_conflict", { name })));
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
        getDefaultChannel().writeLine(pc.green(t("cli.provider_added", { name })));
        getDefaultChannel().writeLine(t("cli.provider_switch_hint"));
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
        getDefaultChannel().writeLine(t("session.no_sessions"));
        return;
      }
      const active = sessionManager.getActive();
      for (const s of sessions) {
        const marker = s.id === active ? "*" : " ";
        getDefaultChannel().writeLine(
          ` ${marker} ${s.id.slice(0, 12)}  ${s.name}  ${s.messageCount} ${t("repl.msgs")}  ${s.updatedAt.slice(0, 10)}`,
        );
      }
    });
  session
    .command("show")
    .argument("<id>", t("cli.session_id"))
    .description(t("cli.show_details"))
    .action(async (id: string) => {
      const { sessionManager } = await bootstrap();
      const meta = sessionManager.get(id);
      if (!meta) {
        getDefaultChannel().writeLine(t("session.not_found", { id }));
        return;
      }
      getDefaultChannel().writeLine(`${t("cli.session_field_id")}           ${meta.id}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_name")}         ${meta.name}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_created")}      ${meta.createdAt}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_updated")}      ${meta.updatedAt}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_messages")}     ${meta.messageCount}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_model")}        ${meta.model}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_context")}      ${meta.contextWindow}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_project")}      ${meta.projectDir}`);

      const moeEvents = sessionManager.loadSessionLog(id).filter((e) => e.type.startsWith("moe_"));
      if (moeEvents.length > 0) {
        getDefaultChannel().writeLine("");
        getDefaultChannel().writeLine(pc.cyan(t("cli.session_moe_events")));
        for (const e of moeEvents) {
          const ts = e.ts.slice(11, 19);
          if (e.type === "moe_subtask") {
            getDefaultChannel().writeLine(
              `  ${pc.dim(ts)} [subtask] ${e.subtaskId} (${e.expertTag}) ${e.status ?? ""}${
                e.durationMs !== undefined ? ` ${e.durationMs}ms` : ""
              }`,
            );
          } else if (e.type === "moe_plan") {
            getDefaultChannel().writeLine(
              `  ${pc.dim(ts)} [plan] ${e.status === "ok" ? e.subtaskIds?.join(", ") : e.status}`,
            );
          } else if (e.type === "moe_replan") {
            getDefaultChannel().writeLine(
              `  ${pc.dim(ts)} [replan] cycle ${e.cycle}: ${e.subtaskIds?.join(", ")}`,
            );
          } else {
            const usage = e.usageByTag
              ? " | usage: " +
                Object.entries(e.usageByTag)
                  .map(([tag, u]) => `${tag}=${u.totalTokens}t`)
                  .join(", ")
              : "";
            getDefaultChannel().writeLine(
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
        getDefaultChannel().writeLine("");
        getDefaultChannel().writeLine(
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
          getDefaultChannel().writeLine(
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
    .command("export")
    .argument("<id>", t("cli.session_id_or_prefix"))
    .description(t("cli.export_session"))
    .option("--format <format>", t("cli.export_format"), "md")
    .option("--out <path>", t("cli.export_out"))
    .option("--no-redact", t("cli.export_no_redact"))
    .option("--compact", t("cli.export_compact"))
    .action(async (id: string, opts: { format: string; out?: string; redact: boolean; compact?: boolean }) => {
      const { sessionManager } = await bootstrap();
      const meta =
        sessionManager.get(id) ??
        sessionManager.list().find((s) => s.id.startsWith(id)) ??
        sessionManager.list().find((s) => s.name.toLowerCase().includes(id.toLowerCase()));
      if (!meta) {
        getDefaultChannel().writeLine(t("session.not_found", { id }));
        return;
      }
      const format = opts.format as ExportFormat;
      if (format !== "md" && format !== "json" && format !== "jsonl") {
        getDefaultChannel().writeLine(t("export.invalid_format", { format }));
        return;
      }
      const messages = sessionManager.getHistory(meta.id);
      const log = sessionManager.loadSessionLog(meta.id);
      if (format === "jsonl" ? log.length === 0 : messages.length === 0) {
        getDefaultChannel().writeLine(t("export.empty"));
        return;
      }
      const text = redactExport(
        formatExport({ meta, messages, log }, format, { compact: opts.compact }),
        opts.redact,
      );
      if (opts.out === "-") {
        getDefaultChannel().writeLine(text);
        return;
      }
      const baseDir = opts.out ? dirname(opts.out) : globalExportsDir();
      const path =
        opts.out ??
        join(
          baseDir,
          `${sanitizeFileName(meta.name)}-${meta.id.slice(0, 8)}.${extensionFor(format)}`,
        );
      try {
        mkdirSync(baseDir, { recursive: true });
        writeFileSync(path, text, "utf-8");
      } catch (e) {
        getDefaultChannel().writeLine(t("export.write_failed", { error: String(e) }));
        return;
      }
      getDefaultChannel().writeLine(t("export.written", { path }));
      getDefaultChannel().writeLine(t(opts.redact ? "export.redacted" : "export.raw"));
    });
  session
    .command("delete")
    .argument("<id>", t("cli.session_id"))
    .description(t("cli.delete_session"))
    .action(async (id: string) => {
      const { sessionManager } = await bootstrap();
      sessionManager.delete(id);
      getDefaultChannel().writeLine(t("session.deleted", { id }));
    });
  session
    .command("prune")
    .description(t("cli.prune_sessions"))
    .option("--dry-run", t("cli.prune_dry_run"))
    .action(async (opts: { dryRun?: boolean }) => {
      const { sessionManager } = await bootstrap();
      const active = sessionManager.getActive();
      const candidates = sessionManager
        .list()
        .filter((s) => s.id !== active && sessionManager.isEmptySession(s.id));
      if (candidates.length === 0) {
        getDefaultChannel().writeLine(t("session.prune_empty"));
        return;
      }
      if (opts.dryRun) {
        getDefaultChannel().writeLine(t("session.prune_dry", { n: candidates.length }));
      } else {
        const deleted = sessionManager.pruneEmpty(active ?? undefined);
        getDefaultChannel().writeLine(t("session.pruned", { n: deleted.length }));
      }
      for (const s of candidates) {
        getDefaultChannel().writeLine(`   ${s.id.slice(0, 12)}  ${s.name}`);
      }
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
        getDefaultChannel().writeLine(pc.yellow(t("cli.changelog_not_found")));
        return;
      }
      if (opts.from) {
        const range = extractChangelogRange(changelog, opts.from, version);
        if (!range) {
          getDefaultChannel().writeLine(pc.yellow(t("cli.changelog_not_found")));
          return;
        }
        getDefaultChannel().writeLine(pc.cyan(t("cli.changelog_range", { from: opts.from })));
        getDefaultChannel().writeLine(range);
      } else {
        const latest = extractLatestChangelog(changelog);
        if (!latest) {
          getDefaultChannel().writeLine(pc.yellow(t("cli.changelog_not_found")));
          return;
        }
        getDefaultChannel().writeLine(pc.cyan(t("cli.changelog_title", { version })));
        getDefaultChannel().writeLine(latest);
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
    .option("--reasoning <level>", t("cli.reasoning_level"), "auto")
    .option("--verbose", t("cli.verbose"))
    .option("--context-log", t("cli.context_log"));

  buildSetupCommand(program);
  buildMeetCommand(program);
  buildInitCommand(program);
  buildAgentsCommand(program);
  buildWebCommand(program);
  buildConfigCommands(program);
  buildModelCommands(program);
  buildContextCommand(program);
  buildUsageCommand(program);
  buildMapCommand(program);
  buildProviderCommands(program);
  buildSessionCommands(program);

  // Подключаем security-команды.
  createSecurityCommand(program);

  // Подключаем plugin-команды.
  createPluginCommand(program);

  buildChangelogCommand(program);

  program
    .argument("[prompt...]", t("cli.prompt_arg"))
    .description(t("cli.run_prompt"))
    .action((_prompt: string[]) => {
      /* Обрабатывает main.ts после program.parse(). */
    });

  // Экшены субкоманд гонят полный bootstrap() (reasoning-пробник, индексер,
  // плагины…), оставляющий открытые хендлы: без явного exit процесс висит после
  // печати результата ("config set" напечатал и не вышел). Prompt/REPL-пути
  // выходят явно в main.ts; каждая СУБКОМАНДА — one-shot: выходим, как резолвнится action.
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
  // `meet`/`agents` — не one-shot: их пустые action лишь маркируют намерение, и
  // main.ts проваливается в интерактивный REPL. `web` долгоживущий (сервер
  // стартует из main.ts после parse). Хук выхода сработал бы во время
  // program.parse() и убил процесс до ветки. `mma init`/`mma setup` — one-shot
  // визарды, обязаны выйти после прогона.
  const longRunningCommands = new Set(["meet", "agents", "web"]);
  for (const cmd of program.commands) {
    if (longRunningCommands.has(cmd.name())) continue;
    attachOneShotExit(cmd);
  }

  return program;
}
