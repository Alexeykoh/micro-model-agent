import { pc } from "../ui/colors";
import { readMmaVersion } from "../core/version";
import { renderTable } from "../ui/table";
import { t } from "../i18n/index";
import { runSetup } from "./setup";
import { saveConfig } from "../config/config";
import { getMessageText } from "../llm/provider";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import type { LineInput } from "../ui/line-editor";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import type { LspModule } from "../modules/lsp/module";

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
  registerCommand(cmd: SlashCommand): void;
  runAgent(input: string): Promise<void>;
  withExclusiveInput(fn: () => Promise<void>): Promise<void>;
  showHelp(): void;
  setupCompleter(): void;
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
  provider: "agent",
  model: "agent",
  context: "agent",
  reload: "agent",
  wizard: "agent",
  sysprompt: "agent",
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
      console.clear();
    },
  });
}

function registerMmaCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "run",
    description: t("repl.run"),
    usage: t("repl.run_usage"),
    action: async (args: string[]) => {
      if (args.length === 0) {
        console.log(t("repl.run_usage"));
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
        console.log(t("repl.image_usage"));
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
            console.log(pc.yellow(t("image.clipboard_empty")));
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
            console.log(pc.red(t("image.not_found", { path: source })));
            return;
          }
          const result = await loadFileAsDataUrl(absPath);
          dataUrl = result.dataUrl;
          label = source;
        }

        const contextManager = ctx.agent.contextManager;
        if (!contextManager) {
          console.log(pc.red(t("image.no_context")));
          return;
        }

        contextManager.addPendingImage({
          type: "image_url",
          image_url: { url: dataUrl },
        });

        const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
        console.log(pc.green(t("image.attached", { source: label, size: `${sizeKb} KB` })));
      } catch (err: any) {
        console.log(pc.red(t("image.error", { message: err.message })));
      }
    },
  });
  ctx.registerCommand({
    name: "config",
    description: t("repl.config"),
    usage: t("repl.config_usage"),
    action: () => {
      const cfg = ctx.config;
      const ctxW = cfg.contextWindow;
      const sys = Math.floor(ctxW * cfg.contextBudget.systemPrompt);
      const res = Math.floor(ctxW * cfg.contextBudget.responseReserve);
      console.log(`${t("repl.model")}       ${cfg.model}`);
      console.log(`${t("repl.provider")}    ${cfg.provider.type}  →  ${cfg.provider.baseUrl}`);
      console.log(
        `${t("repl.context")}     ${ctxW}  (sys:${sys}  res:${res}  hist:${ctxW - sys - res})`,
      );
      console.log(`${t("repl.max_iters")}   ${cfg.maxToolIterations}`);
      console.log(`${t("repl.stuck_thresh")} ${cfg.stuckThreshold}`);
      console.log(
        `${t("repl.reasoning_label")}   ${cfg.showReasoning ? pc.green(t("repl.show")) : pc.dim(t("repl.hide"))}`,
      );
      console.log(`${t("repl.log_level")}   ${cfg.logLevel}`);
      console.log(`${t("repl.locale")}      ${cfg.locale}`);
      const meta = ctx.sessionManager?.getActiveMeta();
      if (meta) {
        console.log(
          `${t("repl.session_label")}     ${meta.name} (${meta.id})  —  ${meta.messageCount} msgs`,
        );
      }
    },
  });
  ctx.registerCommand({
    name: "reasoning",
    description: t("repl.reasoning"),
    usage: t("repl.reasoning_usage"),
    action: () => {
      ctx.config.showReasoning = !ctx.config.showReasoning;
      const status = ctx.config.showReasoning ? pc.green(t("repl.show")) : pc.dim(t("repl.hide"));
      console.log(t("repl.reasoning_status", { status }));
    },
  });
  ctx.registerCommand({
    name: "status",
    description: t("repl.status"),
    usage: t("repl.status_usage"),
    action: () => {
      console.log(`${t("repl.model")} ${ctx.config.model}`);
      console.log(
        `${t("repl.provider")} ${ctx.config.provider.type} @ ${ctx.config.provider.baseUrl}`,
      );
      const meta = ctx.sessionManager?.getActiveMeta();
      if (meta) {
        console.log(
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
      console.log(pc.yellow(t("repl.wizard_running")));
      await ctx.withExclusiveInput(async () => {
        const answers = await runSetup(ctx.rl);
        const configPath = join(homedir(), ".mma", "config.json");
        ctx.config.provider.type = answers.provider;
        ctx.config.provider.baseUrl = answers.apiBase;
        ctx.config.provider.apiKey = answers.apiKey;
        ctx.config.model = answers.model;
        ctx.config.contextWindow = answers.contextWindow;
        ctx.config.maxToolIterations = answers.maxToolIterations;
        ctx.config.locale = answers.locale;
        saveConfig(ctx.config, configPath);
        await ctx.agent.reconfigure(ctx.config);
        console.log(pc.green(t("cli.config_saved")));
      });
    },
  });
  ctx.registerCommand({
    name: "sysprompt",
    description: t("repl.sysprompt_desc"),
    usage: t("repl.sysprompt_desc"),
    action: () => {
      const info = ctx.agent.getSystemPromptInfo();
      console.log(pc.bold(`System prompt (${info.tokenCount} tokens):`));
      console.log(pc.dim("─".repeat(60)));
      for (const line of info.text.split("\n")) {
        console.log(line);
      }
      console.log(pc.dim("─".repeat(60)));
      if (info.excluded.length > 0) {
        console.log(pc.yellow(`\nExcluded blocks: ${info.excluded.length}`));
        for (const e of info.excluded) {
          console.log(pc.dim(`  - ${e.slice(0, 80)}${e.length > 80 ? "..." : ""}`));
        }
      }
    },
  });
  ctx.registerCommand({
    name: "provider",
    description: t("repl.provider_list"),
    usage: t("repl.provider_usage"),
    action: async (args: string[]) => {
      const subcmd = args[0];
      if (!subcmd || subcmd === "list") {
        console.log(`${t("repl.provider_current")}  ${ctx.config.provider.type}`);
        console.log(`  ${ctx.config.provider.baseUrl}`);
        return;
      }
      if (subcmd === "use") {
        const name = args[1];
        if (!name) {
          console.log(t("repl.provider_usage"));
          return;
        }
        ctx.config.provider.type = name;
        const configPath = join(homedir(), ".mma", "config.json");
        saveConfig(ctx.config, configPath);
        await ctx.agent.reconfigure(ctx.config);
        console.log(pc.green(t("repl.provider_set", { name })));
        return;
      }
      console.log(t("repl.provider_usage"));
    },
  });
  ctx.registerCommand({
    name: "model",
    description: t("repl.model_list"),
    usage: t("repl.model_usage"),
    action: async (args: string[]) => {
      const subcmd = args[0];
      if (!subcmd || subcmd === "list") {
        console.log(`${t("repl.model_current")}  ${ctx.config.model}`);

        const { OpenAICompatProvider } = await import("../llm/openai-compat");
        const provider = new OpenAICompatProvider({
          model: ctx.config.model,
          baseUrl: ctx.config.provider.baseUrl,
          apiKey: ctx.config.provider.apiKey,
          contextWindow: ctx.config.contextWindow,
        });

        const { Spinner } = await import("../ui/spinner");
        const s = new Spinner();
        s.start(t("cli.fetching_models"));
        try {
          const models = await provider.listModels();
          s.stop();
          if (models.length > 0) {
            console.log(t("cli.available_models"));
            const { getCertMark } = await import("../modules/certification/manifest");
            for (const m of models) {
              const marker = m === ctx.config.model ? pc.green("* ") : "  ";
              const mark = getCertMark(m, ctx.config.provider.baseUrl, version);
              const cert =
                mark === "certified"
                  ? pc.green("✔")
                  : mark === "stale"
                    ? pc.yellow("○")
                    : pc.dim("·");
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
        return;
      }
      if (subcmd === "use") {
        const name = args[1];
        if (!name) {
          console.log(t("repl.model_usage"));
          return;
        }
        ctx.config.model = name;
        const configPath = join(homedir(), ".mma", "config.json");
        saveConfig(ctx.config, configPath);
        await ctx.agent.reconfigure(ctx.config);
        console.log(pc.green(t("repl.model_set", { name })));
        return;
      }
      console.log(t("repl.model_usage"));
    },
  });
  ctx.registerCommand({
    name: "context",
    description: t("cli.manage_context"),
    usage: "/context <size>",
    action: async (args: string[]) => {
      if (args.length === 0) {
        console.log(`/context ${t("repl.context")}  ${ctx.config.contextWindow}`);
        console.log(`Usage: /context <size>  (min 1024)`);
        return;
      }
      const size = parseInt(args[0], 10);
      if (isNaN(size) || size < 1024) {
        console.log(t("cli.invalid_context_size"));
        return;
      }
      ctx.config.contextWindow = size;
      const configPath = join(homedir(), ".mma", "config.json");
      saveConfig(ctx.config, configPath);
      await ctx.agent.reconfigure(ctx.config);
      console.log(pc.green(t("cli.context_set", { size })));
    },
  });
  ctx.registerCommand({
    name: "reload",
    description: t("repl.reload"),
    usage: t("repl.reload_usage"),
    action: async () => {
      console.log(pc.yellow(t("repl.reloading")));

      if (ctx.sessionManager && ctx.config.session.autoSave) {
      }

      ctx.agent.shutdown();

      const { loadConfig } = await import("../config/config");
      const { homedir } = await import("os");
      const { join } = await import("path");
      const configDir = ctx.configDir;
      const baseDir = ctx.baseDir;
      const projectConfigPath = join(baseDir, ".mmrc");

      const freshConfig = loadConfig({ configDir, projectConfigPath });

      Object.assign(ctx.config, freshConfig);

      const { bootstrap } = await import("../core/bootstrap");
      const result = await bootstrap(configDir, baseDir, false, false);

      (ctx as any).agent = result.agent;
      (ctx as any).sessionManager = result.sessionManager;
      (ctx as any).skillsModule = result.skillsModule;
      (ctx as any).pluginManager = result.pluginManager;

      ctx.setupCompleter();

      console.log(pc.green(t("repl.reloaded")));
      console.log(`${t("repl.model")}       ${ctx.config.model}`);
      console.log(`${t("repl.context")}     ${ctx.config.contextWindow}`);
      console.log(
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
        console.log(t("cli.plugins.none"));
        return;
      }
      const showAll = args.includes("--all");
      const infos = ctx.pluginManager.getPluginInfos();
      const filtered = showAll ? infos : infos.filter(({ plugin }) => !plugin.isBuiltin);
      if (filtered.length === 0) {
        console.log(t("cli.plugins.none"));
        return;
      }
      const mmaVersion = version;
      console.log(
        t("cli.plugins.header", {
          count: String(filtered.length),
          mma: mmaVersion,
        }),
      );
      for (const { plugin, source } of filtered) {
        const v = plugin.version || "-";
        const origin = source || "builtin";
        const mark = plugin.isBuiltin ? t("cli.plugins.builtin_mark") : " ";
        console.log(`  ${mark} ${plugin.name}  v${v}  [${origin}]`);
      }
      if (!showAll) {
        const builtinCount = infos.filter(({ plugin }) => plugin.isBuiltin).length;
        if (builtinCount > 0) {
          console.log(pc.dim(`  (${builtinCount} builtin hidden — /plugins --all to show)`));
        }
      }
    },
  });

  ctx.registerCommand({
    name: "lsp",
    description: t("repl.lsp"),
    usage: t("repl.lsp_usage"),
    action: async (args: string[]) => {
      const subcommand = args[0] || "status";

      // Access LSP module via the agent's module registry
      const lspModule = ctx.agent.getModule<LspModule>("lsp");

      if (!lspModule) {
        console.log(pc.yellow(t("repl.lsp_not_available")));
        return;
      }

      switch (subcommand) {
        case "status": {
          const disabled = lspModule.getDisabledServers();
          const failures = lspModule.getFailureCounts();
          const config = ctx.config.lsp;

          console.log(pc.bold(t("repl.lsp_status_header")));
          console.log(`${t("repl.lsp_enabled")} ${config?.enabled ? pc.green("yes") : pc.red("no")}`);

          if (disabled.length > 0) {
            console.log(pc.yellow(`${t("repl.lsp_disabled_servers")} ${disabled.join(", ")}`));
          }

          if (failures.size > 0) {
            console.log(pc.dim(t("repl.lsp_failure_counts")));
            for (const [server, count] of failures) {
              console.log(pc.dim(`  ${server}: ${count}`));
            }
          }

          if (disabled.length === 0 && failures.size === 0) {
            console.log(pc.green(t("repl.lsp_all_ok")));
          }
          break;
        }

        case "restart": {
          console.log(pc.yellow(t("repl.lsp_restarting")));
          lspModule.resetDisabledServers();
          console.log(pc.green(t("repl.lsp_restarted")));
          break;
        }

        case "check": {
          const path = args[1];
          if (!path) {
            console.log(pc.yellow(t("repl.lsp_check_usage")));
            return;
          }
          console.log(pc.dim(t("repl.lsp_checking", { path })));
          // Run lsp_check tool via the agent's tool executor
          try {
            const result = await (ctx.agent as any).deps?.toolExecutor?.execute(
              "lsp_check",
              { path },
              (ctx.agent as any).deps?.toolCtx,
            );
            if (result?.output) {
              console.log(result.output);
            }
          } catch (e) {
            console.log(pc.red(t("repl.lsp_check_error", {
              error: e instanceof Error ? e.message : String(e),
            })));
          }
          break;
        }

        default: {
          console.log(pc.dim(t("repl.lsp_usage")));
          break;
        }
      }
    },
  });
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
        console.log(t("session.no_sessions_hint"));
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
        console.log(line);
      }
      console.log(pc.dim(`\n  ${t("repl.resume_hint")}`));
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
      console.clear();
      console.log(`${t("session.created", { name: meta.name })} (${pc.dim(meta.id.slice(0, 12))})`);
      console.log(pc.dim(`  ${t("session.chat_cleared")}\n`));
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
        console.log(pc.dim(t("session.available")));
        const active = ctx.sessionManager!.getActive();
        for (const s of sessions) {
          const marker = s.id === active ? pc.green(" *") : "  ";
          console.log(pc.dim(` ${marker} ${s.id.slice(0, 12)}  ${s.name}`));
        }
        console.log(pc.dim(`\n  ${t("repl.resume_usage")}`));
        return;
      }
      const match = sessions.find(
        (s) =>
          s.id === query ||
          s.id.startsWith(query) ||
          s.name.toLowerCase().includes(query.toLowerCase()),
      );
      if (!match) {
        console.log(t("session.no_match", { query }));
        return;
      }
      ctx.sessionManager!.setActive(match.id);
      const history = ctx.sessionManager!.loadHistory();
      ctx.agent.setContext(history);
      console.clear();
      console.log(
        pc.bold(pc.green(t("session.resumed", { name: match.name }))) +
          " " +
          pc.dim(`(${match.id.slice(0, 12)})`) +
          "  —  " +
          match.messageCount +
          " msgs",
      );
      console.log(pc.dim("─".repeat(50)));
      if (history.length === 0) {
        console.log(pc.dim(t("session.no_history")));
      } else {
        console.log(pc.dim(t("session.chat_history")));
        console.log();
        for (const msg of history) {
          if (msg.role === "user") {
            console.log(pc.cyan(t("session.user_label") + ":"));
            console.log(getMessageText(msg.content));
            console.log();
          } else if (msg.role === "assistant") {
            console.log(pc.green(t("session.assistant_label") + ":"));
            console.log(getMessageText(msg.content));
            console.log();
          }
        }
      }
      console.log(pc.dim("─".repeat(50)));
      console.log(pc.dim(`  ${t("session.chat_loaded")}`));
    },
  });

  ctx.registerCommand({
    name: "rename",
    description: t("repl.rename"),
    usage: t("repl.rename_usage"),
    action: (args: string[]) => {
      const name = args.join(" ");
      if (!name) {
        console.log(t("repl.rename_usage"));
        return;
      }
      const active = ctx.sessionManager!.getActive();
      if (!active) {
        console.log(t("session.no_active"));
        return;
      }
      ctx.sessionManager!.rename(active, name);
      console.log(t("session.renamed", { name }));
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
        console.log(t("repl.delete_usage"));
        return;
      }
      const sessions = ctx.sessionManager!.list();
      const match = sessions.find((s) => s.id === query || s.id.startsWith(query));
      if (!match) {
        console.log(t("session.no_match", { query }));
        return;
      }
      ctx.sessionManager!.delete(match.id);
      console.log(`${t("session.deleted", { id: match.id })}: ${match.name}`);
    },
  });
}

function registerSkillCommands(ctx: ReplContext): void {
  if (!ctx.skillsModule) return;

  ctx.registerCommand({
    name: "skill",
    description: t("repl.skill"),
    usage: t("repl.skill_usage"),
    action: (args: string[]) => {
      const subcmd = args[0];
      const arg = args.slice(1).join(" ");

      if (!subcmd || subcmd === "list") {
        const available = ctx.skillsModule!.getAvailable();
        if (available.length === 0) {
          console.log(t("repl.no_skills"));
          return;
        }
        console.log(pc.bold(t("repl.available_skills")));
        for (const skill of available) {
          const tokens = Math.ceil(skill.content.length / 4);
          const loaded = ctx.skillsModule!.getLoaded().some((s) => s.name === skill.name);
          const marker = loaded ? pc.green(" [loaded]") : "";
          console.log(
            `  ${pc.cyan(skill.name)}${marker}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
          );
        }
        return;
      }

      if (subcmd === "loaded") {
        const loaded = ctx.skillsModule!.getLoaded();
        const budget = ctx.skillsModule!.getBudget();
        if (loaded.length === 0) {
          console.log(t("repl.no_loaded"));
          return;
        }
        console.log(pc.bold(t("repl.loaded_skills")));
        for (const skill of loaded) {
          const tokens = Math.ceil(skill.content.length / 4);
          console.log(
            `  ${pc.cyan(skill.name)}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
          );
        }
        console.log(
          pc.dim(
            `\n  ${t("repl.budget", { used: budget.used, total: budget.total, remaining: budget.remaining })}`,
          ),
        );
        return;
      }

      if (subcmd === "load") {
        if (!arg) {
          console.log(t("repl.skill_load_usage"));
          return;
        }
        const result = ctx.skillsModule!.loadByName(arg);
        if (result.success) {
          console.log(pc.green(result.message));
        } else {
          console.log(pc.red(result.message));
        }
        return;
      }

      if (subcmd === "unload") {
        if (!arg) {
          console.log(t("repl.skill_unload_usage"));
          return;
        }
        if (ctx.skillsModule!.unload(arg)) {
          console.log(pc.green(t("repl.skill_unloaded", { name: arg })));
        } else {
          console.log(pc.red(t("repl.skill_not_loaded", { name: arg })));
        }
        return;
      }

      if (subcmd === "search") {
        if (!arg) {
          console.log(t("repl.skill_search_usage"));
          return;
        }
        const results = ctx.skillsModule!.search(arg);
        if (results.length === 0) {
          console.log(t("repl.no_skill_match", { query: arg }));
          return;
        }
        console.log(pc.bold(t("repl.skills_matching", { query: arg })));
        for (const skill of results) {
          const tokens = Math.ceil(skill.content.length / 4);
          console.log(
            `  ${pc.cyan(skill.name)}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
          );
        }
        return;
      }

      console.log(pc.red(t("repl.skill_unknown_sub", { subcmd })));
      console.log(t("repl.skill_usage"));
    },
  });
}
