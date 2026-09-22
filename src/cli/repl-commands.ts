import { pc } from "../ui/colors";
import { readMmaVersion } from "../core/version";
import { renderTable } from "../ui/table";
import { t } from "../i18n/index";
import { runSetup } from "./setup";
import { applyAnswersToConfig } from "./setup-order";
import { saveConfig } from "../config/config";
import { HOSTED_BASE_URLS } from "../modules/providers/presets";
import { budgetBreakdownLines, setBudgetShare } from "../config/budget";
import { getMessageText } from "../llm/provider";
import { estimateTokens } from "../llm/token-counter";
import { join, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import type { LineInput } from "../ui/line-editor";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import type { LspModule } from "../modules/lsp/module";
import type { IndexerModule } from "../modules/indexer/module";
import { runMapAction } from "../modules/indexer/map-command";
import { errMsg } from "../utils";
import type { OutputChannel } from "../output";

const version = readMmaVersion();

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
  usage?: string;
  action(args: string[]): void | Promise<void>;
}

export interface ReplContext {
  readonly config: AppConfig;
  readonly agent: Agent;
  readonly rl: LineInput;
  readonly sessionManager?: SessionManager;
  readonly skillsModule?: SkillsModule;
  readonly pluginManager?: PluginManager;
  readonly configDir: string;
  readonly baseDir: string;
  /** Single terminal writer — commands must never write to console/stdout directly. */
  readonly output: OutputChannel;
  registerCommand(cmd: SlashCommand): void;
  runAgent(input: string): Promise<void>;
  withExclusiveInput(fn: () => Promise<void>): Promise<void>;
  showHelp(): void;
  setupCompleter(): void;
  refreshModelCache(): void;
  attachHostBridge(pluginManager?: PluginManager): void;
  /** Перезагрузка агента и модулей (команда /reload). */
  reload(): Promise<void>;
  stop(): void;
}

export const COMMAND_GROUPS: Record<string, string> = {
  help: "general",
  exit: "general",
  clear: "general",
  run: "general",
  image: "general",
  config: "agent",
  status: "agent",
  reasoning: "agent",
  verbose: "agent",
  provider: "agent",
  model: "agent",
  context: "agent",
  reload: "agent",
  wizard: "agent",
  sysprompt: "agent",
  map: "agent",
  lsp: "agent",
  sessions: "session",
  new: "session",
  resume: "session",
  rename: "session",
  delete: "session",
  skill: "skill",
  plugins: "agent",
};

export function registerAllCommands(ctx: ReplContext): void {
  registerBuiltinCommands(ctx);
  registerMmaCommands(ctx);
  registerSessionCommands(ctx);
  registerSkillCommands(ctx);
}

function registerBuiltinCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "help",
    description: t("repl.help"),
    usage: t("repl.help_usage"),
    action: () => ctx.showHelp(),
  });
  ctx.registerCommand({
    name: "exit",
    description: t("repl.exit"),
    aliases: ["quit", "q"],
    usage: t("repl.exit_usage"),
    action: () => ctx.stop(),
  });
  ctx.registerCommand({
    name: "clear",
    description: t("repl.clear"),
    usage: t("repl.clear_usage"),
    action: () => {
      ctx.output.clearScreen();
    },
  });
}

function registerRunCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "run",
    description: t("repl.run"),
    usage: t("repl.run_usage"),
    action: async (args: string[]) => {
      if (args.length === 0) {
        ctx.output.writeLine(t("repl.run_usage"));
        return;
      }
      const prompt = args.join(" ");
      await ctx.runAgent(prompt);
    },
  });
  ctx.registerCommand({
    name: "image",
    description: t("repl.image"),
    aliases: ["img"],
    usage: t("repl.image_usage"),
    action: async (args: string[]) => {
      const source = args.join(" ");
      if (!source) {
        ctx.output.writeLine(t("repl.image_usage"));
        return;
      }
      try {
        const { loadFileAsDataUrl, loadUrlAsDataUrl, readClipboardImage } =
          await import("../llm/image-utils");
        const { existsSync } = await import("fs");
        const { resolve } = await import("path");

        let dataUrl: string;
        let label: string;

        if (source.toLowerCase() === "clipboard") {
          const clipBuf = await readClipboardImage();
          if (!clipBuf) {
            ctx.output.writeLine(pc.yellow(t("image.clipboard_empty")));
            return;
          }
          const { bufferToDataUrl } = await import("../llm/image-utils");
          const result = await bufferToDataUrl(clipBuf);
          dataUrl = result.dataUrl;
          label = "clipboard";
        } else if (source.startsWith("http://") || source.startsWith("https://")) {
          const result = await loadUrlAsDataUrl(source);
          dataUrl = result.dataUrl;
          label = source;
        } else {
          const absPath = resolve(process.cwd(), source);
          if (!existsSync(absPath)) {
            ctx.output.writeLine(pc.red(t("image.not_found", { path: source })), "stderr");
            return;
          }
          const result = await loadFileAsDataUrl(absPath);
          dataUrl = result.dataUrl;
          label = source;
        }

        const contextManager = ctx.agent.contextManager;
        if (!contextManager) {
          ctx.output.writeLine(pc.red(t("image.no_context")), "stderr");
          return;
        }

        contextManager.addPendingImage({
          type: "image_url",
          image_url: { url: dataUrl },
        });

        const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
        ctx.output.writeLine(
          pc.green(t("image.attached", { source: label, size: `${sizeKb} KB` })),
        );
      } catch (err: any) {
        ctx.output.writeLine(pc.red(t("image.error", { message: err.message })), "stderr");
      }
    },
  });
}

function registerConfigCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "config",
    description: t("repl.config"),
    usage: t("repl.config_usage"),
    action: (args: string[]) => {
      // Subcommand routing: `/config migrate`. A separate registration with
      // a space in the name was unreachable — the dispatcher splits input on
      // whitespace, so "/config migrate" always resolved to plain "config".
      if ((args[0] ?? "").trim().toLowerCase() === "migrate") {
        return runConfigMigrate(ctx);
      }
      const cfg = ctx.config;
      const ctxW = cfg.contextWindow;
      const sys = Math.floor(ctxW * cfg.contextBudget.systemPrompt);
      const res = Math.floor(ctxW * cfg.contextBudget.responseReserve);
      ctx.output.writeLine(`${t("repl.model")}       ${cfg.model}`);
      const providers = ctx.agent.listProviders();
      const active = providers.find((p) => p.active);
      if (active) {
        ctx.output.writeLine(
          `${t("repl.provider")}    ${active.label} (${pc.dim(active.type)})  →  ${pc.dim(active.baseUrl)}`,
        );
      } else {
        ctx.output.writeLine(
          `${t("repl.provider")}    ${cfg.provider.type}  →  ${cfg.provider.baseUrl}`,
        );
      }
      ctx.output.writeLine(
        `${t("repl.context")}     ${ctxW}  (sys:${sys}  res:${res}  hist:${ctxW - sys - res})`,
      );
      ctx.output.writeLine(`${t("repl.max_iters")}   ${cfg.maxToolIterations}`);
      ctx.output.writeLine(`${t("repl.stuck_thresh")} ${cfg.stuckThreshold}`);
      ctx.output.writeLine(
        `${t("repl.reasoning_label")}   ${cfg.showReasoning ? pc.green(t("repl.show")) : pc.dim(t("repl.hide"))}`,
      );
      ctx.output.writeLine(`${t("repl.log_level")}   ${cfg.logLevel}`);
      ctx.output.writeLine(`${t("repl.locale")}      ${cfg.locale}`);
      const meta = ctx.sessionManager?.getActiveMeta();
      if (meta) {
        ctx.output.writeLine(
          `${t("repl.session_label")}     ${meta.name} (${meta.id})  —  ${meta.messageCount} msgs`,
        );
      }
    },
  });
  ctx.registerCommand({
    name: "reasoning",
    description: t("repl.reasoning"),
    usage: t("repl.reasoning_usage"),
    action: (args: string[]) => {
      const level = args[0]?.trim().toLowerCase();
      const VALID_LEVELS = ["auto", "none", "low", "medium", "high", "max"];
      if (!level) {
        // Toggle show/hide reasoning content
        ctx.config.showReasoning = !ctx.config.showReasoning;
        const status = ctx.config.showReasoning ? pc.green(t("repl.show")) : pc.dim(t("repl.hide"));
        ctx.output.writeLine(t("repl.reasoning_status", { status }));
      } else if (VALID_LEVELS.includes(level)) {
        // Set reasoning effort level
        ctx.agent.setReasoningLevel(level as any);
        ctx.output.writeLine(pc.green(t("repl.reasoning_level_set", { level })));
      } else {
        ctx.output.writeLine(
          pc.yellow(t("repl.reasoning_invalid_level", { level, valid: VALID_LEVELS.join(", ") })),
        );
      }
    },
  });
  ctx.registerCommand({
    name: "verbose",
    description: t("repl.verbose"),
    usage: t("repl.verbose_usage"),
    action: (args: string[]) => {
      const VALID = ["quiet", "normal", "verbose"];
      const level = args[0]?.trim().toLowerCase();
      if (level && !VALID.includes(level)) {
        ctx.output.writeLine(
          pc.yellow(t("repl.verbose_invalid_level", { level, valid: VALID.join(", ") })),
        );
        return;
      }
      const current = ctx.config.ui.verbosity ?? (ctx.config.ui.verbose ? "verbose" : "quiet");
      const next = (level ?? (current === "verbose" ? "quiet" : "verbose")) as
        | "quiet"
        | "normal"
        | "verbose";
      ctx.config.ui.verbosity = next;
      ctx.output.setSuppressInfoLogs(next === "quiet");
      ctx.output.writeLine(pc.green(t("repl.verbose_set", { level: next })));
    },
  });
  ctx.registerCommand({
    name: "status",
    description: t("repl.status"),
    usage: t("repl.status_usage"),
    action: () => {
      const providers = ctx.agent.listProviders();
      const active = providers.find((p) => p.active);
      ctx.output.writeLine(`${t("repl.model")} ${ctx.config.model}`);
      if (active) {
        ctx.output.writeLine(
          `${t("repl.provider")} ${active.label} (${pc.dim(active.type)}) @ ${pc.dim(active.baseUrl)}`,
        );
      } else {
        ctx.output.writeLine(
          `${t("repl.provider")} ${ctx.config.provider.type} @ ${pc.dim(ctx.config.provider.baseUrl)}`,
        );
      }
      const meta = ctx.sessionManager?.getActiveMeta();
      if (meta) {
        ctx.output.writeLine(
          `${t("repl.session_label")} ${meta.name} (${meta.id}) — ${meta.messageCount} messages`,
        );
      }
    },
  });
  ctx.registerCommand({
    name: "wizard",
    description: t("repl.wizard"),
    aliases: ["setup"],
    usage: t("repl.wizard_usage"),
    action: async () => {
      ctx.output.writeLine(pc.yellow(t("repl.wizard_running")));
      await ctx.withExclusiveInput(async () => {
        const answers = await runSetup(ctx.rl);
        const configPath = join(ctx.configDir, "config.json");
        const hadEntries = (ctx.config.provider.entries?.length ?? 0) > 0;
        applyAnswersToConfig(ctx.config, answers);
        if (hadEntries) {
          // Multi-entry configs resolve the active provider from `entries[]`, so
          // the wizard choice must be written onto the active entry — without
          // dropping the other providers or the entry's tuning (contextWindow,
          // cache, retry, rateLimits).
          const entries = ctx.config.provider.entries ?? [];
          const activeName =
            ctx.config.provider.active || entries[0]?.label || entries[0]?.type;
          const idx = entries.findIndex(
            (e) => e.label === activeName || e.type === activeName,
          );
          const target = idx >= 0 ? idx : 0;
          const updated = {
            ...entries[target],
            type: answers.provider,
            baseUrl: answers.apiBase,
            apiKey: answers.apiKey,
          };
          const next = entries.slice();
          next[target] = updated;
          ctx.config.provider.entries = next;
          ctx.config.provider.active = updated.label || updated.type;
        }
        saveConfig(ctx.config, configPath, dirname(configPath));
        await ctx.agent.reconfigure(ctx.config);
        ctx.output.writeLine(pc.green(t("cli.config_saved")));
      });
    },
  });
  ctx.registerCommand({
    name: "sysprompt",
    description: t("repl.sysprompt_desc"),
    usage: t("repl.sysprompt_desc"),
    action: () => {
      const info = ctx.agent.getSystemPromptInfo();
      ctx.output.writeLine(pc.bold(t("repl.sysprompt_tokens", { count: String(info.tokenCount) })));
      ctx.output.writeLine(pc.dim("─".repeat(60)));
      for (const line of info.text.split("\n")) {
        ctx.output.writeLine(line);
      }
      ctx.output.writeLine(pc.dim("─".repeat(60)));
      if (info.excluded.length > 0) {
        ctx.output.writeLine(
          pc.yellow(t("repl.excluded_blocks", { count: String(info.excluded.length) })),
        );
        for (const e of info.excluded) {
          ctx.output.writeLine(pc.dim(`  - ${e.slice(0, 80)}${e.length > 80 ? "..." : ""}`));
        }
      }
    },
  });
  ctx.registerCommand({
    name: "map",
    description: t("repl.map"),
    usage: t("repl.map_usage"),
    action: async (args: string[]) => {
      const indexer = ctx.agent.getModule<IndexerModule>("indexer");
      if (!indexer) {
        ctx.output.writeLine(pc.yellow(t("indexer.not_indexed")));
        return;
      }
      const action = args[0] || "summary";
      const query = args.slice(1).join(" ");
      const result = await runMapAction(indexer, action, query);
      ctx.output.writeLine(result.output);
    },
  });
}

function registerProviderCommands(ctx: ReplContext): void {
  const list = (): void => {
    const providers = ctx.agent.listProviders();
    if (providers.length === 0) {
      ctx.output.writeLine(`${t("repl.provider_current")}  ${ctx.config.provider.type}`);
      ctx.output.writeLine(`  ${ctx.config.provider.baseUrl}`);
      return;
    }
    ctx.output.writeLine(t("repl.provider_current"));
    for (const p of providers) {
      const marker = p.active ? pc.green("* ") : "  ";
      ctx.output.writeLine(` ${marker}${p.label}  (${pc.dim(p.type)})  ${pc.dim(p.baseUrl)}`);
    }
  };

  const use = async (args: string[]): Promise<void> => {
    const name = args[0];
    if (!name) {
      ctx.output.writeLine(t("repl.provider_usage"));
      return;
    }
    try {
      await ctx.agent.setProvider(name);
      ctx.refreshModelCache();
      ctx.output.writeLine(pc.green(t("repl.provider_set", { name })));
    } catch (e: any) {
      ctx.output.writeLine(pc.red(e.message), "stderr");
    }
  };

  const add = async (args: string[]): Promise<void> => {
    const flags: Record<string, string> = {};
    let name: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith("--")) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          ctx.output.writeLine(
            pc.red(t("repl.provider_add_missing_value", { flag: arg })),
            "stderr",
          );
          return;
        }
        flags[arg.slice(2)] = value;
        i++;
      } else if (name === undefined) {
        name = arg;
      }
    }
    if (!name) {
      ctx.output.writeLine(t("repl.provider_usage"));
      return;
    }
    const entries = Array.isArray(ctx.config.provider.entries) ? ctx.config.provider.entries : [];
    if (entries.length === 0) {
      entries.push({
        type: ctx.config.provider.type,
        label: ctx.config.provider.type,
        baseUrl: ctx.config.provider.baseUrl,
        apiKey: ctx.config.provider.apiKey,
      });
    }
    const baseUrl =
      flags.url || HOSTED_BASE_URLS[name] || HOSTED_BASE_URLS[`opencode-${name}`] || "";
    if (!baseUrl) {
      ctx.output.writeLine(pc.red(t("cli.provider_no_url", { name })), "stderr");
      return;
    }
    entries.push({
      type: name,
      label: name,
      baseUrl,
      apiKey: flags.key,
      ...(flags.priority !== undefined ? { priority: Number(flags.priority) } : {}),
      ...(flags["context-window"] !== undefined
        ? { contextWindow: Number(flags["context-window"]) }
        : {}),
      ...(flags.rpm !== undefined || flags.parallel !== undefined
        ? {
            rateLimits: {
              maxRequestsPerMinute: Number(flags.rpm ?? 0) || 60,
              maxParallelTasks: Number(flags.parallel ?? 0) || 1,
            },
          }
        : {}),
    });
    ctx.config.provider.entries = entries;
    ctx.config.provider.active = ctx.config.provider.active || ctx.config.provider.type;
    const configPath = join(ctx.configDir, "config.json");
    saveConfig(ctx.config, configPath, dirname(configPath));
    await ctx.agent.reconfigure(ctx.config);
    ctx.output.writeLine(pc.green(t("cli.provider_added", { name })));
    ctx.output.writeLine(t("repl.provider_switch_hint", { name }));
  };

  const handlers: Record<string, (args: string[]) => void | Promise<void>> = {
    list,
    use,
    add,
  };

  ctx.registerCommand({
    name: "provider",
    description: t("repl.provider_list"),
    usage: t("repl.provider_usage"),
    action: async (args: string[]) => {
      const subcmd = args[0];
      const handler = subcmd ? handlers[subcmd] : handlers.list;
      if (!handler) {
        ctx.output.writeLine(t("repl.provider_usage"));
        return;
      }
      await handler(args.slice(1));
    },
  });
  const listModels = async (): Promise<void> => {
    ctx.output.writeLine(`${t("repl.model_current")}  ${ctx.config.model}`);

    const { OpenAICompatProvider } = await import("../llm/openai-compat");
    const provider = new OpenAICompatProvider({
      model: ctx.config.model,
      baseUrl: ctx.config.provider.baseUrl,
      apiKey: ctx.config.provider.apiKey,
      contextWindow: ctx.config.contextWindow,
    });

    const { Spinner } = await import("../ui/spinner");
    const s = new Spinner({ channel: ctx.output });
    s.start(t("cli.fetching_models"));
    try {
      const models = await provider.listModels();
      s.stop();
      if (models.length > 0) {
        ctx.refreshModelCache();
        ctx.output.writeLine(t("cli.available_models"));
        const { getCertMark } = await import("../modules/certification/manifest");
        for (const m of models) {
          const marker = m === ctx.config.model ? pc.green("* ") : "  ";
          const mark = getCertMark(m, ctx.config.provider.baseUrl, version, process.cwd());
          const cert =
            mark === "certified" ? pc.green("✔") : mark === "stale" ? pc.yellow("○") : pc.dim("·");
          const label =
            mark === "certified"
              ? `  ${pc.green(t("cli.cert_label"))}`
              : mark === "stale"
                ? `  ${pc.yellow(t("cli.cert_stale_label"))}`
                : "";
          ctx.output.writeLine(` ${marker}${cert} ${m}${label}`);
        }
      } else {
        ctx.output.writeLine(t("cli.no_models_found"));
      }
    } catch (err) {
      s.stop();
      ctx.output.writeLine(t("cli.model_fetch_failed", { error: String(err) }), "stderr");
    }

    ctx.output.writeLine(t("cli.model_hint"));
  };

  const useModel = async (args: string[]): Promise<void> => {
    const name = args[0];
    if (!name) {
      ctx.output.writeLine(t("repl.model_usage"));
      return;
    }
    ctx.config.model = name;
    const configPath = join(ctx.configDir, "config.json");
    saveConfig(ctx.config, configPath, dirname(configPath));
    await ctx.agent.reconfigure(ctx.config);
    ctx.output.writeLine(pc.green(t("repl.model_set", { name })));
  };

  const modelHandlers: Record<string, (args: string[]) => void | Promise<void>> = {
    list: listModels,
    use: useModel,
  };

  ctx.registerCommand({
    name: "model",
    description: t("repl.model_list"),
    usage: t("repl.model_usage"),
    action: async (args: string[]) => {
      const subcmd = args[0];
      const handler = subcmd ? modelHandlers[subcmd] : modelHandlers.list;
      if (!handler) {
        ctx.output.writeLine(t("repl.model_usage"));
        return;
      }
      await handler(args.slice(1));
    },
  });
  ctx.registerCommand({
    name: "context",
    description: t("cli.manage_context"),
    usage: t("repl.context_usage"),
    action: async (args: string[]) => {
      const save = async () => {
        const configPath = join(ctx.configDir, "config.json");
        saveConfig(ctx.config, configPath, dirname(configPath));
        await ctx.agent.reconfigure(ctx.config);
      };

      if (args.length === 0) {
        for (const line of budgetBreakdownLines(ctx.config)) ctx.output.writeLine(line);
        ctx.output.writeLine(pc.dim(t("repl.context_usage")));
        return;
      }

      if (args[0] === "system" || args[0] === "reserve") {
        const key = args[0] as "system" | "reserve";
        const value = Number(args[1]);
        if (setBudgetShare(ctx.config, key, value) !== null) {
          ctx.output.writeLine(pc.yellow(t("cli.context_invalid_fraction")));
          return;
        }
        await save();
        ctx.output.writeLine(pc.green(t("cli.context_fraction_set", { key, value })));
        return;
      }

      const size = parseInt(args[0], 10);
      if (isNaN(size) || size < 1024) {
        ctx.output.writeLine(t("cli.invalid_context_size"));
        return;
      }
      ctx.config.contextWindow = size;
      await save();
      ctx.output.writeLine(pc.green(t("cli.context_set", { size })));
    },
  });
}

function registerAgentCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "reload",
    description: t("repl.reload"),
    usage: t("repl.reload_usage"),
    action: async () => {
      ctx.output.writeLine(pc.yellow(t("repl.reloading")));
      await ctx.reload();
      ctx.output.writeLine(pc.green(t("repl.reloaded")));
      ctx.output.writeLine(`${t("repl.model")}       ${ctx.config.model}`);
      ctx.output.writeLine(`${t("repl.context")}     ${ctx.config.contextWindow}`);
      ctx.output.writeLine(
        `${t("repl.provider")}    ${ctx.config.provider.type} @ ${ctx.config.provider.baseUrl}`,
      );
    },
  });
  ctx.registerCommand({
    name: "plugins",
    description: t("repl.plugins"),
    usage: t("repl.plugins_usage"),
    action: (args: string[]) => {
      if (!ctx.pluginManager) {
        ctx.output.writeLine(t("cli.plugins.none"));
        return;
      }
      const showAll = args.includes("--all");
      const infos = ctx.pluginManager.getPluginInfos();
      const filtered = showAll ? infos : infos.filter(({ plugin }) => !plugin.isBuiltin);
      if (filtered.length === 0) {
        ctx.output.writeLine(t("cli.plugins.none"));
        return;
      }
      const mmaVersion = version;
      ctx.output.writeLine(
        t("cli.plugins.header", {
          count: String(filtered.length),
          mma: mmaVersion,
        }),
      );
      for (const { plugin, source } of filtered) {
        const v = plugin.version || "-";
        const origin = source || "builtin";
        const mark = plugin.isBuiltin ? t("cli.plugins.builtin_mark") : " ";
        ctx.output.writeLine(`  ${mark} ${plugin.name}  v${v}  [${origin}]`);
      }
      if (!showAll) {
        const builtinCount = infos.filter(({ plugin }) => plugin.isBuiltin).length;
        if (builtinCount > 0) {
          ctx.output.writeLine(
            pc.dim(`  (${builtinCount} builtin hidden — /plugins --all to show)`),
          );
        }
      }
    },
  });
}

function registerLspCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "lsp",
    description: t("repl.lsp"),
    usage: t("repl.lsp_usage"),
    action: async (args: string[]) => {
      const subcommand = args[0] || "status";

      // Access LSP module via the agent's module registry
      const lspModule = ctx.agent.getModule<LspModule>("lsp");

      if (!lspModule) {
        ctx.output.writeLine(pc.yellow(t("repl.lsp_not_available")));
        return;
      }

      switch (subcommand) {
        case "status": {
          const disabled = lspModule.getDisabledServers();
          const failures = lspModule.getFailureCounts();
          const config = ctx.config.lsp;

          ctx.output.writeLine(pc.bold(t("repl.lsp_status_header")));
          ctx.output.writeLine(
            `${t("repl.lsp_enabled")} ${config?.enabled ? pc.green("yes") : pc.red("no")}`,
          );

          if (disabled.length > 0) {
            ctx.output.writeLine(
              pc.yellow(`${t("repl.lsp_disabled_servers")} ${disabled.join(", ")}`),
            );
          }

          if (failures.size > 0) {
            ctx.output.writeLine(pc.dim(t("repl.lsp_failure_counts")));
            for (const [server, count] of failures) {
              ctx.output.writeLine(pc.dim(`  ${server}: ${count}`));
            }
          }

          if (disabled.length === 0 && failures.size === 0) {
            ctx.output.writeLine(pc.green(t("repl.lsp_all_ok")));
          }
          break;
        }

        case "restart": {
          ctx.output.writeLine(pc.yellow(t("repl.lsp_restarting")));
          lspModule.resetDisabledServers();
          ctx.output.writeLine(pc.green(t("repl.lsp_restarted")));
          break;
        }

        case "check": {
          const path = args[1];
          if (!path) {
            ctx.output.writeLine(pc.yellow(t("repl.lsp_check_usage")));
            return;
          }
          ctx.output.writeLine(pc.dim(t("repl.lsp_checking", { path })));
          // Запуск тула lsp_check через публичный API агента (не через приватные deps)
          try {
            const result = await ctx.agent.runTool("lsp_check", { path });
            if (result?.output) {
              ctx.output.writeLine(result.output);
            }
          } catch (e) {
            ctx.output.writeLine(pc.red(t("repl.lsp_check_error", { error: errMsg(e) })), "stderr");
          }
          break;
        }

        default: {
          ctx.output.writeLine(pc.dim(t("repl.lsp_usage")));
          break;
        }
      }
    },
  });
}

function registerMmaCommands(ctx: ReplContext): void {
  registerRunCommands(ctx);
  registerConfigCommands(ctx);
  registerProviderCommands(ctx);
  registerAgentCommands(ctx);
  registerLspCommands(ctx);
}

function registerSessionCommands(ctx: ReplContext): void {
  if (!ctx.sessionManager) return;

  ctx.registerCommand({
    name: "sessions",
    description: t("repl.sessions"),
    aliases: ["ls"],
    usage: t("repl.sessions_usage"),
    action: () => {
      const sessions = ctx.sessionManager!.list();
      const active = ctx.sessionManager!.getActive();
      if (sessions.length === 0) {
        ctx.output.writeLine(t("session.no_sessions_hint"));
        return;
      }
      const rows = sessions.map((s) => [
        s.id === active ? pc.green("●") : "",
        s.id.slice(0, 12),
        s.name,
        s.updatedAt.slice(0, 19).replace("T", " "),
        String(s.messageCount),
      ]);
      for (const line of renderTable(
        [
          t("session.col_active"),
          t("session.col_id"),
          t("session.col_name"),
          t("session.col_updated"),
          t("session.col_msgs"),
        ],
        rows,
      )) {
        ctx.output.writeLine(line);
      }
      ctx.output.writeLine(pc.dim(`\n  ${t("repl.resume_hint")}`));
    },
  });

  ctx.registerCommand({
    name: "new",
    description: t("repl.new"),
    aliases: ["create"],
    usage: t("repl.new_usage"),
    action: (args: string[]) => {
      const name = args.join(" ") || undefined;
      const meta = ctx.sessionManager!.create(name);
      ctx.agent.clearContext();
      ctx.output.clearScreen();
      ctx.output.writeLine(
        `${t("session.created", { name: meta.name })} (${pc.dim(meta.id.slice(0, 12))})`,
      );
      ctx.output.writeLine(pc.dim(`  ${t("session.chat_cleared")}\n`));
    },
  });

  ctx.registerCommand({
    name: "resume",
    description: t("repl.resume"),
    aliases: ["switch", "use"],
    usage: t("repl.resume_usage"),
    action: (args: string[]) => {
      const query = args.join(" ");
      const sessions = ctx.sessionManager!.list();
      if (!query) {
        ctx.output.writeLine(pc.dim(t("session.available")));
        const active = ctx.sessionManager!.getActive();
        for (const s of sessions) {
          const marker = s.id === active ? pc.green(" *") : "  ";
          ctx.output.writeLine(pc.dim(` ${marker} ${s.id.slice(0, 12)}  ${s.name}`));
        }
        ctx.output.writeLine(pc.dim(`\n  ${t("repl.resume_usage")}`));
        return;
      }
      const match = sessions.find(
        (s) =>
          s.id === query ||
          s.id.startsWith(query) ||
          s.name.toLowerCase().includes(query.toLowerCase()),
      );
      if (!match) {
        ctx.output.writeLine(t("session.no_match", { query }));
        return;
      }
      ctx.sessionManager!.setActive(match.id);
      const history = ctx.sessionManager!.loadHistory();
      ctx.agent.setContext(history);
      ctx.output.clearScreen();
      ctx.output.writeLine(
        pc.bold(pc.green(t("session.resumed", { name: match.name }))) +
          " " +
          pc.dim(`(${match.id.slice(0, 12)})`) +
          "  —  " +
          match.messageCount +
          " " +
          t("repl.msgs"),
      );
      ctx.output.writeLine(pc.dim("─".repeat(50)));
      if (history.length === 0) {
        ctx.output.writeLine(pc.dim(t("session.no_history")));
      } else {
        ctx.output.writeLine(pc.dim(t("session.chat_history")));
        ctx.output.writeLine("");
        for (const msg of history) {
          if (msg.role === "user") {
            ctx.output.writeLine(pc.cyan(t("session.user_label") + ":"));
            ctx.output.writeLine(getMessageText(msg.content));
            ctx.output.writeLine("");
          } else if (msg.role === "assistant") {
            ctx.output.writeLine(pc.green(t("session.assistant_label") + ":"));
            ctx.output.writeLine(getMessageText(msg.content));
            ctx.output.writeLine("");
          }
        }
      }
      ctx.output.writeLine(pc.dim("─".repeat(50)));
      ctx.output.writeLine(pc.dim(`  ${t("session.chat_loaded")}`));
    },
  });

  ctx.registerCommand({
    name: "rename",
    description: t("repl.rename"),
    usage: t("repl.rename_usage"),
    action: (args: string[]) => {
      const name = args.join(" ");
      if (!name) {
        ctx.output.writeLine(t("repl.rename_usage"));
        return;
      }
      const active = ctx.sessionManager!.getActive();
      if (!active) {
        ctx.output.writeLine(t("session.no_active"));
        return;
      }
      ctx.sessionManager!.rename(active, name);
      ctx.output.writeLine(t("session.renamed", { name }));
    },
  });

  ctx.registerCommand({
    name: "delete",
    description: t("repl.delete"),
    aliases: ["rm"],
    usage: t("repl.delete_usage"),
    action: (args: string[]) => {
      const query = args[0];
      if (!query) {
        ctx.output.writeLine(t("repl.delete_usage"));
        return;
      }
      const sessions = ctx.sessionManager!.list();
      const match = sessions.find((s) => s.id === query || s.id.startsWith(query));
      if (!match) {
        ctx.output.writeLine(t("session.no_match", { query }));
        return;
      }
      ctx.sessionManager!.delete(match.id);
      ctx.output.writeLine(`${t("session.deleted", { id: match.id })}: ${match.name}`);
    },
  });
}

function registerSkillCommands(ctx: ReplContext): void {
  if (!ctx.skillsModule) return;

  const listSkills = (): void => {
    const available = ctx.skillsModule!.getAvailable();
    if (available.length === 0) {
      ctx.output.writeLine(t("repl.no_skills"));
      return;
    }
    ctx.output.writeLine(pc.bold(t("repl.available_skills")));
    for (const skill of available) {
      const tokens = estimateTokens(skill.content);
      const loaded = ctx.skillsModule!.getLoaded().some((s) => s.name === skill.name);
      const marker = loaded ? pc.green(" [loaded]") : "";
      ctx.output.writeLine(
        `  ${pc.cyan(skill.name)}${marker}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
      );
    }
  };

  const listLoaded = (): void => {
    const loaded = ctx.skillsModule!.getLoaded();
    const budget = ctx.skillsModule!.getBudget();
    if (loaded.length === 0) {
      ctx.output.writeLine(t("repl.no_loaded"));
      return;
    }
    ctx.output.writeLine(pc.bold(t("repl.loaded_skills")));
    for (const skill of loaded) {
      const tokens = estimateTokens(skill.content);
      ctx.output.writeLine(
        `  ${pc.cyan(skill.name)}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
      );
    }
    ctx.output.writeLine(
      pc.dim(
        `\n  ${t("repl.budget", { used: budget.used, total: budget.total, remaining: budget.remaining })}`,
      ),
    );
  };

  const loadSkill = (args: string[]): void => {
    const arg = args.join(" ");
    if (!arg) {
      ctx.output.writeLine(t("repl.skill_load_usage"));
      return;
    }
    const result = ctx.skillsModule!.loadByName(arg);
    if (result.success) {
      ctx.output.writeLine(pc.green(result.message));
    } else {
      ctx.output.writeLine(pc.red(result.message), "stderr");
    }
  };

  const unloadSkill = (args: string[]): void => {
    const arg = args.join(" ");
    if (!arg) {
      ctx.output.writeLine(t("repl.skill_unload_usage"));
      return;
    }
    if (ctx.skillsModule!.unload(arg)) {
      ctx.output.writeLine(pc.green(t("repl.skill_unloaded", { name: arg })));
    } else {
      ctx.output.writeLine(pc.red(t("repl.skill_not_loaded", { name: arg })), "stderr");
    }
  };

  const searchSkills = (args: string[]): void => {
    const arg = args.join(" ");
    if (!arg) {
      ctx.output.writeLine(t("repl.skill_search_usage"));
      return;
    }
    const results = ctx.skillsModule!.search(arg);
    if (results.length === 0) {
      ctx.output.writeLine(t("repl.no_skill_match", { query: arg }));
      return;
    }
    ctx.output.writeLine(pc.bold(t("repl.skills_matching", { query: arg })));
    for (const skill of results) {
      const tokens = estimateTokens(skill.content);
      ctx.output.writeLine(
        `  ${pc.cyan(skill.name)}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
      );
    }
  };

  const skillHandlers: Record<string, (args: string[]) => void> = {
    list: listSkills,
    loaded: listLoaded,
    load: loadSkill,
    unload: unloadSkill,
    search: searchSkills,
  };

  ctx.registerCommand({
    name: "skill",
    description: t("repl.skill"),
    usage: t("repl.skill_usage"),
    action: (args: string[]) => {
      const subcmd = args[0];
      const handler = subcmd ? skillHandlers[subcmd] : skillHandlers.list;
      if (!handler) {
        ctx.output.writeLine(pc.red(t("repl.skill_unknown_sub", { subcmd })), "stderr");
        ctx.output.writeLine(t("repl.skill_usage"));
        return;
      }
      handler(args.slice(1));
    },
  });
}

async function runConfigMigrate(ctx: ReplContext): Promise<void> {
  const { hasDomainFiles } = await import("../config/domains");
  const { loadConfig: loadCfg } = await import("../config/config");
  const configDir = ctx.configDir;
  const configPath = join(configDir, "config.json");

  if (hasDomainFiles(configDir)) {
    ctx.output.writeLine(pc.yellow(t("config.migrate_no_legacy")));
    return;
  }

  if (!existsSync(configPath)) {
    ctx.output.writeLine(pc.yellow(t("config.migrate_no_legacy")));
    return;
  }

  ctx.output.writeLine(t("config.migrate_start"));

  const { config } = loadCfg({ configDir, projectConfigPath: join(configDir, ".mmrc") });
  saveConfig(config, configPath, configDir);

  const { renameSync, readdirSync } = await import("fs");
  renameSync(configPath, configPath + ".bak");

  const domainFiles = readdirSync(join(configDir, "config")).filter((f: string) =>
    f.endsWith(".json"),
  );
  ctx.output.writeLine(pc.green(t("config.migrate_done", { count: String(domainFiles.length) })));
}
