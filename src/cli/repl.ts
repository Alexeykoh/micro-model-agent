import * as readline from "readline";
import { pc } from "../ui/colors";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  Completer,
  SlashCommandProvider,
  SessionNameProvider,
  SubcommandProvider,
  SkillNameProvider,
} from "./completer";
import { Renderer } from "../ui/renderer";
import { box, divider } from "../ui/box";
import { renderTable } from "../ui/table";
import { t } from "../i18n/index";
import { runSetup } from "./setup";
import { saveConfig } from "../config/config";
import { getMessageText } from "../llm/provider";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";

interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
  usage?: string;
  action(args: string[]): void | Promise<void>;
}

const COMMAND_GROUPS: Record<string, string> = {
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
  sessions: "session",
  new: "session",
  resume: "session",
  rename: "session",
  delete: "session",
  skill: "skill",
};

function formatContextBar(used: number, limit: number): string {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const barLen = 20;
  const filled = Math.round((pct / 100) * barLen);
  const bar =
    pc.green("█".repeat(filled)) + pc.dim("░".repeat(barLen - filled));
  const pctStr = pct >= 75 ? pc.yellow(`${pct}%`) : pc.dim(`${pct}%`);
  return `  ${bar}  ${pctStr}  ${pc.dim(`(${used} / ${limit} tokens)`)}`;
}

export class Repl {
  private rl: readline.Interface;
  private commands: Map<string, SlashCommand> = new Map();
  private completer: Completer = new Completer();
  private running = false;
  private agentRunning = false;
  private agent: Agent;
  private config: AppConfig;
  private sessionManager?: SessionManager;
  private skillsModule?: SkillsModule;
  private pluginManager?: PluginManager;
  private historyPath: string;
  private history: string[] = [];
  private maxHistory = 1000;
  private lastEscTime = 0;
  private readonly doubleEscDelay = 500;
  private configDir: string;
  private baseDir: string;
  private noAgentsMd: boolean;

  constructor(
    agent: Agent,
    config: AppConfig,
    sessionManager?: SessionManager,
    skillsModule?: SkillsModule,
    pluginManager?: PluginManager,
    configDir?: string,
    baseDir?: string,
    noAgentsMd?: boolean,
  ) {
    this.agent = agent;
    this.config = config;
    this.sessionManager = sessionManager;
    this.skillsModule = skillsModule;
    this.pluginManager = pluginManager;
    this.configDir = configDir || join(homedir(), ".mma");
    this.baseDir = baseDir || process.cwd();
    this.noAgentsMd = noAgentsMd === true;
    this.historyPath = join(homedir(), ".mma", "repl-history");
    this.loadHistory();
    this.registerBuiltinCommands();
    this.registerMmaCommands();
    this.registerSessionCommands();
    this.registerSkillCommands();
    this.setupCompleter();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: pc.cyan("> "),
      history: this.history,
      historySize: this.maxHistory,
      tabSize: 2,
      completer: (line: string) => {
        const [matches, partial] = this.completer.complete(line);
        if (matches.length > 0) return [matches, partial];
        return [[], line];
      },
    });
    this.setupListeners();
  }

  private loadHistory(): void {
    if (existsSync(this.historyPath)) {
      try {
        const raw = readFileSync(this.historyPath, "utf-8");
        this.history = raw.split("\n").filter(Boolean).slice(-this.maxHistory);
      } catch {
        this.history = [];
      }
    }
  }

  private saveHistory(): void {
    const allHistory = this.history.slice(-this.maxHistory);
    writeFileSync(this.historyPath, allHistory.join("\n"), "utf-8");
  }

  private registerBuiltinCommands(): void {
    this.registerCommand({
      name: "help",
      description: t("repl.help"),
      usage: t("repl.help_usage"),
      action: () => this.showHelp(),
    });
    this.registerCommand({
      name: "exit",
      description: t("repl.exit"),
      aliases: ["quit", "q"],
      usage: t("repl.exit_usage"),
      action: () => this.stop(),
    });
    this.registerCommand({
      name: "clear",
      description: t("repl.clear"),
      usage: t("repl.clear_usage"),
      action: () => {
        console.clear();
      },
    });
  }

  private registerMmaCommands(): void {
    this.registerCommand({
      name: "run",
      description: t("repl.run"),
      usage: t("repl.run_usage"),
      action: async (args: string[]) => {
        if (args.length === 0) {
          console.log(t("repl.run_usage"));
          return;
        }
        const prompt = args.join(" ");
        await this.runAgent(prompt);
      },
    });
    this.registerCommand({
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
          const { loadFileAsDataUrl, loadUrlAsDataUrl, readClipboardImage } = await import("../llm/image-utils");
          const { existsSync } = await import("fs");
          const { resolve } = await import("path");

          let dataUrl: string;
          let label: string;

          if (source.toLowerCase() === "clipboard") {
            const clipPath = await readClipboardImage();
            if (!clipPath) {
              console.log(pc.yellow(t("image.clipboard_empty")));
              return;
            }
            const result = loadFileAsDataUrl(clipPath);
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
            const result = loadFileAsDataUrl(absPath);
            dataUrl = result.dataUrl;
            label = source;
          }

          // Store the image data on the agent's context manager for the next message
          const contextManager = this.agent.contextManager;
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
    this.registerCommand({
      name: "config",
      description: t("repl.config"),
      usage: t("repl.config_usage"),
      action: () => {
        const ctx = this.config.contextWindow;
        const sys = Math.floor(ctx * this.config.contextBudget.systemPrompt);
        const res = Math.floor(ctx * this.config.contextBudget.responseReserve);
        console.log(`${t("repl.model")}       ${this.config.model}`);
        console.log(
          `${t("repl.provider")}    ${this.config.provider.type}  →  ${this.config.provider.baseUrl}`,
        );
        console.log(
          `${t("repl.context")}     ${ctx}  (sys:${sys}  res:${res}  hist:${ctx - sys - res})`,
        );
        console.log(
          `${t("repl.max_iters")}   ${this.config.maxToolIterations}`,
        );
        console.log(`${t("repl.stuck_thresh")} ${this.config.stuckThreshold}`);
        console.log(
          `${t("repl.reasoning_label")}   ${this.config.showReasoning ? pc.green(t("repl.show")) : pc.dim(t("repl.hide"))}`,
        );
        console.log(`${t("repl.log_level")}   ${this.config.logLevel}`);
        console.log(`${t("repl.locale")}      ${this.config.locale}`);
        const meta = this.sessionManager?.getActiveMeta();
        if (meta) {
          console.log(
            `${t("repl.session_label")}     ${meta.name} (${meta.id})  —  ${meta.messageCount} msgs`,
          );
        }
      },
    });
    this.registerCommand({
      name: "reasoning",
      description: t("repl.reasoning"),
      usage: t("repl.reasoning_usage"),
      action: () => {
        this.config.showReasoning = !this.config.showReasoning;
        const status = this.config.showReasoning
          ? pc.green(t("repl.show"))
          : pc.dim(t("repl.hide"));
        console.log(t("repl.reasoning_status", { status }));
      },
    });
    this.registerCommand({
      name: "status",
      description: t("repl.status"),
      usage: t("repl.status_usage"),
      action: () => {
        console.log(`${t("repl.model")} ${this.config.model}`);
        console.log(
          `${t("repl.provider")} ${this.config.provider.type} @ ${this.config.provider.baseUrl}`,
        );
        const meta = this.sessionManager?.getActiveMeta();
        if (meta) {
          console.log(
            `${t("repl.session_label")} ${meta.name} (${meta.id}) — ${meta.messageCount} messages`,
          );
        }
      },
    });
    this.registerCommand({
      name: "wizard",
      description: t("repl.wizard"),
      aliases: ["setup"],
      usage: t("repl.wizard_usage"),
      action: async () => {
        console.log(pc.yellow(t("repl.wizard_running")));
        const answers = await runSetup();
        const configPath = join(homedir(), ".mma", "config.json");
        this.config.provider.type = answers.provider;
        this.config.provider.baseUrl = answers.apiBase;
        this.config.provider.apiKey = answers.apiKey;
        this.config.model = answers.model;
        this.config.contextWindow = answers.contextWindow;
        this.config.maxToolIterations = answers.maxToolIterations;
        this.config.locale = answers.locale;
        saveConfig(this.config, configPath);
        console.log(pc.green(t("cli.config_saved")));
      },
    });
    this.registerCommand({
      name: "provider",
      description: t("repl.provider_list"),
      usage: t("repl.provider_usage"),
      action: (args: string[]) => {
        const subcmd = args[0];
        if (!subcmd || subcmd === "list") {
          console.log(
            `${t("repl.provider_current")}  ${this.config.provider.type}`,
          );
          console.log(`  ${this.config.provider.baseUrl}`);
          return;
        }
        if (subcmd === "use") {
          const name = args[1];
          if (!name) {
            console.log(t("repl.provider_usage"));
            return;
          }
          this.config.provider.type = name;
          const configPath = join(homedir(), ".mma", "config.json");
          saveConfig(this.config, configPath);
          console.log(pc.green(t("repl.provider_set", { name })));
          return;
        }
        console.log(t("repl.provider_usage"));
      },
    });
    this.registerCommand({
      name: "model",
      description: t("repl.model_list"),
      usage: t("repl.model_usage"),
      action: async (args: string[]) => {
        const subcmd = args[0];
        if (!subcmd || subcmd === "list") {
          console.log(`${t("repl.model_current")}  ${this.config.model}`);
          
          // Fetch available models from provider
          const { OpenAICompatProvider } = await import("../llm/openai-compat");
          const provider = new OpenAICompatProvider({
            model: this.config.model,
            baseUrl: this.config.provider.baseUrl,
            apiKey: this.config.provider.apiKey,
            contextWindow: this.config.contextWindow,
          });
          
          const { Spinner } = await import("../ui/spinner");
          const s = new Spinner();
          s.start(t("cli.fetching_models"));
          try {
            const models = await provider.listModels();
            s.stop();
            if (models.length > 0) {
              console.log(t("cli.available_models"));
              for (const m of models) {
                const marker = m === this.config.model ? pc.green("* ") : "  ";
                console.log(` ${marker}${m}`);
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
          this.config.model = name;
          const configPath = join(homedir(), ".mma", "config.json");
          saveConfig(this.config, configPath);
          console.log(pc.green(t("repl.model_set", { name })));
          return;
        }
        console.log(t("repl.model_usage"));
      },
    });
    this.registerCommand({
      name: "context",
      description: t("cli.manage_context"),
      usage: "/context <size>",
      action: (args: string[]) => {
        if (args.length === 0) {
          console.log(`/context ${t("repl.context")}  ${this.config.contextWindow}`);
          console.log(`Usage: /context <size>  (min 1024)`);
          return;
        }
        const size = parseInt(args[0], 10);
        if (isNaN(size) || size < 1024) {
          console.log(t("cli.invalid_context_size"));
          return;
        }
        this.config.contextWindow = size;
        const configPath = join(homedir(), ".mma", "config.json");
        saveConfig(this.config, configPath);
        console.log(pc.green(t("cli.context_set", { size })));
      },
    });
    this.registerCommand({
      name: "reload",
      description: t("repl.reload"),
      usage: t("repl.reload_usage"),
      action: async () => {
        console.log(pc.yellow(t("repl.reloading")));
        
        // Save current session if auto-save enabled
        if (this.sessionManager && this.config.session.autoSave) {
          const active = this.sessionManager.getActiveMeta();
          if (active) {
            // Session is already auto-saved on each message
          }
        }
        
        // Shutdown current agent
        this.agent.shutdown();
        
        // Reload config from disk
        const { loadConfig } = await import("../config/config");
        const { homedir } = await import("os");
        const { join } = await import("path");
        const configDir = join(homedir(), ".mma");
        const projectConfigPath = join(process.cwd(), ".mmrc");
        
        const freshConfig = loadConfig({ configDir, projectConfigPath });
        
        // Update config reference
        Object.assign(this.config, freshConfig);
        
        // Recreate agent with new config (re-bootstrap)
        const { bootstrap } = await import("../core/bootstrap");
        const result = await bootstrap(
          configDir,
          process.cwd(),
          this.noAgentsMd,
          false
        );
        
        // Replace agent and related components
        this.agent = result.agent;
        this.sessionManager = result.sessionManager;
        this.skillsModule = result.skillsModule;
        this.pluginManager = result.pluginManager;
        
        // Update completer with new session/skill data
        this.setupCompleter();
        
        console.log(pc.green(t("repl.reloaded")));
        console.log(`${t("repl.model")}       ${this.config.model}`);
        console.log(`${t("repl.context")}     ${this.config.contextWindow}`);
        console.log(`${t("repl.provider")}    ${this.config.provider.type} @ ${this.config.provider.baseUrl}`);
      },
    });
  }

  private registerSessionCommands(): void {
    if (!this.sessionManager) return;

    this.registerCommand({
      name: "sessions",
      description: t("repl.sessions"),
      aliases: ["ls"],
      usage: t("repl.sessions_usage"),
      action: () => {
        const sessions = this.sessionManager!.list();
        const active = this.sessionManager!.getActive();
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

    this.registerCommand({
      name: "new",
      description: t("repl.new"),
      aliases: ["create"],
      usage: t("repl.new_usage"),
      action: (args: string[]) => {
        const name = args.join(" ") || undefined;
        const meta = this.sessionManager!.create(name);
        this.agent.clearContext();
        console.clear();
        console.log(
          `${t("session.created", { name: meta.name })} (${pc.dim(meta.id.slice(0, 12))})`,
        );
        console.log(pc.dim(`  ${t("session.chat_cleared")}\n`));
      },
    });

    this.registerCommand({
      name: "resume",
      description: t("repl.resume"),
      aliases: ["switch", "use"],
      usage: t("repl.resume_usage"),
      action: (args: string[]) => {
        const query = args.join(" ");
        const sessions = this.sessionManager!.list();
        if (!query) {
          console.log(pc.dim(t("session.available")));
          const active = this.sessionManager!.getActive();
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
        this.sessionManager!.setActive(match.id);
        const history = this.sessionManager!.loadHistory();
        this.agent.setContext(history);
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

    this.registerCommand({
      name: "rename",
      description: t("repl.rename"),
      usage: t("repl.rename_usage"),
      action: (args: string[]) => {
        const name = args.join(" ");
        if (!name) {
          console.log(t("repl.rename_usage"));
          return;
        }
        const active = this.sessionManager!.getActive();
        if (!active) {
          console.log(t("session.no_active"));
          return;
        }
        this.sessionManager!.rename(active, name);
        console.log(t("session.renamed", { name }));
      },
    });

    this.registerCommand({
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
        const sessions = this.sessionManager!.list();
        const match = sessions.find(
          (s) => s.id === query || s.id.startsWith(query),
        );
        if (!match) {
          console.log(t("session.no_match", { query }));
          return;
        }
        this.sessionManager!.delete(match.id);
        console.log(`${t("session.deleted", { id: match.id })}: ${match.name}`);
      },
    });
  }

  private registerSkillCommands(): void {
    if (!this.skillsModule) return;

    this.registerCommand({
      name: "skill",
      description: t("repl.skill"),
      usage: t("repl.skill_usage"),
      action: (args: string[]) => {
        const subcmd = args[0];
        const arg = args.slice(1).join(" ");

        if (!subcmd || subcmd === "list") {
          const available = this.skillsModule!.getAvailable();
          if (available.length === 0) {
            console.log(t("repl.no_skills"));
            return;
          }
          console.log(pc.bold(t("repl.available_skills")));
          for (const skill of available) {
            const tokens = Math.ceil(skill.content.length / 4);
            const loaded = this.skillsModule!.getLoaded().some(
              (s) => s.name === skill.name,
            );
            const marker = loaded ? pc.green(" [loaded]") : "";
            console.log(
              `  ${pc.cyan(skill.name)}${marker}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
            );
          }
          return;
        }

        if (subcmd === "loaded") {
          const loaded = this.skillsModule!.getLoaded();
          const budget = this.skillsModule!.getBudget();
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
          const result = this.skillsModule!.loadByName(arg);
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
          if (this.skillsModule!.unload(arg)) {
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
          const results = this.skillsModule!.search(arg);
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

  private setupCompleter(): void {
    const slashCommands = Array.from(this.commands.keys());
    this.completer.registerProvider(new SlashCommandProvider(slashCommands));
    if (this.sessionManager) {
      this.completer.registerProvider(
        new SessionNameProvider(() =>
          this.sessionManager!.list().map((s) => s.name),
        ),
      );
    }
    if (this.skillsModule) {
      this.completer.registerProvider(
        new SubcommandProvider("skill", [
          "list",
          "loaded",
          "load",
          "unload",
          "search",
        ]),
      );
      this.completer.registerProvider(new SkillNameProvider(this.skillsModule));
    }
  }

  private setupListeners(): void {
    let multiLineBuffer = "";
    let inMultiLine = false;

    this.rl.on("line", async (line: string) => {
      const trimmed = line.trim();

      if (this.agentRunning) {
        if (trimmed) {
          this.history.push(trimmed);
          if (this.history.length > this.maxHistory) {
            this.history = this.history.slice(-this.maxHistory);
          }
        }
        return;
      }

      if (trimmed) {
        this.history.push(trimmed);
        if (this.history.length > this.maxHistory) {
          this.history = this.history.slice(-this.maxHistory);
        }
      }

      if (inMultiLine) {
        multiLineBuffer += "\n" + line;
        if (!this.isMultiLineInput(multiLineBuffer)) {
          inMultiLine = false;
          const fullInput = multiLineBuffer.trim();
          multiLineBuffer = "";
          if (fullInput) {
            if (fullInput.startsWith("/")) {
              await this.executeCommand(fullInput);
            } else {
              await this.runAgent(fullInput);
            }
          }
          if (this.running) {
            this.rl.setPrompt(pc.cyan("> "));
            this.rl.prompt();
          }
        } else {
          this.rl.setPrompt(pc.cyan("... "));
          this.rl.prompt();
        }
        return;
      }

      if (this.isMultiLineInput(trimmed)) {
        inMultiLine = true;
        multiLineBuffer = trimmed;
        this.rl.setPrompt(pc.cyan("... "));
        this.rl.prompt();
        return;
      }

      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      if (trimmed.startsWith("/")) {
        await this.executeCommand(trimmed);
      } else {
        await this.runAgent(trimmed);
      }

      if (this.running) {
        this.rl.prompt();
      }
    });

    this.rl.on("close", () => {
      this.running = false;
    });

    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", (str, key) => {
        if (key.name === "escape") {
          const now = Date.now();
          if (now - this.lastEscTime < this.doubleEscDelay) {
            console.log(pc.yellow("\n\n[Ctrl+C] Остановка агента..."));
            this.agent.shutdown();
            this.running = false;
            this.saveHistory();
            this.rl.close();
            process.exit(0);
          }
          this.lastEscTime = now;
        }
      });
    }
  }

  private isMultiLineInput(line: string): boolean {
    if (line.endsWith("\\")) return true;

    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    if (openBraces > closeBraces) return true;

    return false;
  }

  private async runAgent(input: string): Promise<void> {
    if (this.agentRunning) return;
    this.agentRunning = true;
    this.rl.pause();
    try {
      process.stdout.write("\n" + pc.green(t("repl.agent")));

      const renderer = new Renderer({ spinner: this.config.ui?.spinner ?? true });
      const result = await this.agent.run(
        input,
        (c) => renderer.text(c),
        (m) => renderer.meta(m),
        (ev) => {
          if (ev.type === "start") {
            renderer.toolStart(ev.tool, ev.args);
          } else {
            renderer.toolEnd(ev.tool, ev.duration ?? 0, ev.error);
          }
        },
        (phase) => {
          if (phase === "thinking") {
            renderer.thinkingStart();
          } else {
            renderer.thinkingEnd();
          }
        },
      );
      renderer.flush();
      process.stdout.write("\n");

      if (!result.success) {
        console.error(pc.red(`${t("error.prefix")}${result.error}`));
      }
      this.showContextBar(result);
    } finally {
      this.agentRunning = false;
      if (this.running) {
        this.rl.resume();
      }
    }
  }

  registerCommand(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.set(alias, cmd);
      }
    }
  }

  private async executeCommand(input: string): Promise<void> {
    const parts = input.split(/\s+/);
    const name = parts[0].slice(1);
    const args = parts.slice(1);

    const cmd = this.commands.get(name);
    if (!cmd) {
      console.log(pc.red(t("cli.unknown_cmd", { name })), t("cli.help_hint"));
      return;
    }

    try {
      await cmd.action(args);
    } catch (err) {
      console.error(
        pc.red(
          t("error.command_error", {
            message: err instanceof Error ? err.message : String(err),
          }),
        ),
      );
    }
  }

  private showHelp(): void {
    const order = ["general", "agent", "session", "skill"];
    const seen = new Set<string>();

    for (const groupKey of order) {
      const cmds: SlashCommand[] = [];
      for (const [name, cmd] of this.commands) {
        if (cmd.aliases?.includes(name)) continue;
        if (seen.has(cmd.name)) continue;
        const group = COMMAND_GROUPS[cmd.name] ?? "general";
        if (group !== groupKey) continue;
        seen.add(cmd.name);
        cmds.push(cmd);
      }
      if (cmds.length === 0) continue;

      console.log(pc.bold(t(`repl.group.${groupKey}`)));
      for (const cmd of cmds) {
        const aliases = cmd.aliases?.length
          ? ` (${pc.dim(cmd.aliases.join(", "))})`
          : "";
        console.log(
          `  ${pc.cyan("/" + cmd.name)}${aliases}  ${pc.dim(cmd.description)}`,
        );
        if (cmd.usage) {
          console.log(`    ${pc.dim(cmd.usage)}`);
        }
      }
      console.log();
    }
  }

  private showContextBar(result: {
    contextUsed?: number;
    contextLimit?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }): void {
    if (
      result.contextUsed !== undefined &&
      result.contextLimit !== undefined &&
      result.contextLimit > 0
    ) {
      console.log();
      const ctxLine = formatContextBar(result.contextUsed, result.contextLimit);
      console.log(ctxLine);
      if (result.totalTokens !== undefined && result.totalTokens > 0) {
        const apiLine = pc.dim(
          `  API: ${result.promptTokens} prompt + ${result.completionTokens} completion = ${result.totalTokens} total`,
        );
        console.log(apiLine);
      }
    }
  }

  start(): void {
    this.running = true;

    const info: string[] = [];
    const row = (label: string, value: string): void => {
      info.push(` ${pc.yellow(label)} ${value}`);
    };

    const ctx = this.config.contextWindow;
    const sysBudget = Math.floor(ctx * this.config.contextBudget.systemPrompt);
    const resBudget = Math.floor(ctx * this.config.contextBudget.responseReserve);
    const histBudget = ctx - sysBudget - resBudget;

    row(
      t("repl.model"),
      pc.white(this.config.model),
    );
    row(
      t("repl.provider"),
      `${this.config.provider.type}  →  ${pc.dim(this.config.provider.baseUrl)}`,
    );
    row(
      t("repl.context"),
      `${pc.white(String(ctx))}  ${pc.dim(`(sys:${sysBudget}  res:${resBudget}  hist:${histBudget})`)}`,
    );

    if (this.skillsModule) {
      const budget = this.skillsModule.getBudget();
      row(
        t("repl.skills_label"),
        `${pc.white(String(this.skillsModule.getAvailable().length))} available, ${pc.dim(`budget: ${budget.total} tokens`)}`,
      );
    }

    if (this.pluginManager) {
      const plugins = this.pluginManager
        .getAllPlugins()
        .filter((p) => !p.isBuiltin);
      if (plugins.length > 0) {
        const pluginNames = plugins.map((p) => p.name).join(", ");
        row(
          t("repl.plugins_label"),
          `${pc.white(String(plugins.length))} active  ${pc.dim(`(${pluginNames})`)}`,
        );
      }
    }

    const mcpServers = this.config.mcpServers || {};
    const enabledServers = Object.entries(mcpServers).filter(
      ([, s]) => s.enabled !== false,
    );
    if (enabledServers.length > 0) {
      const names = enabledServers.map(([name]) => name).join(", ");
      row(
        t("repl.mcp_label"),
        `${pc.white(String(enabledServers.length))}  ${pc.dim(`(${names})`)}`,
      );
    }

    const cwd = process.cwd();
    row(t("repl.work_dir"), pc.dim(cwd));

    if (this.noAgentsMd) {
      row(t("repl.agents_label"), pc.red(t("repl.disabled")));
    } else {
      const agentsMdCandidates = [
        join(this.baseDir, "AGENTS.md"),
        join(this.baseDir, ".mma", "AGENTS.md"),
        join(this.configDir, "AGENTS.md"),
      ];
      const foundAgents = agentsMdCandidates.filter((p) => existsSync(p));
      if (foundAgents.length > 0) {
        for (const p of foundAgents) {
          row(t("repl.agents_label"), pc.dim(p));
        }
      } else {
        row(t("repl.agents_label"), pc.dim(t("repl.not_found")));
      }
    }

    const meta = this.sessionManager?.getActiveMeta();
    if (meta) {
      const sessionPath = join(this.configDir, "sessions", meta.id);
      row(
        t("repl.session_label"),
        `${pc.cyan(meta.name)} ${pc.dim(`(${meta.id.slice(0, 12)})`)}  —  ${meta.messageCount} msgs  ${pc.dim(sessionPath)}`,
      );
    }

    const headerWidth = Math.max(50, Math.min(96, process.stdout.columns || 96));
    for (const line of box(info, { title: t("repl.title"), width: headerWidth })) {
      console.log(line);
    }
    console.log();
    this.rl.prompt();
  }

  stop(): void {
    this.running = false;
    this.saveHistory();
    this.agent.shutdown();
    this.rl.close();
  }
}
