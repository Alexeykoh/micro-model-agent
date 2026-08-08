import * as readline from "readline";
import { pc } from "../ui/colors";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import {
  Completer,
  SlashCommandProvider,
  SessionNameProvider,
  SubcommandProvider,
  SkillNameProvider,
} from "./completer";
import { Renderer } from "../ui/renderer";
import { box, divider } from "../ui/box";
import { t } from "../i18n/index";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import { registerAllCommands } from "./repl-commands";
import type { ReplContext, SlashCommand } from "./repl-commands";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "package.json"),
    join(here, "..", "package.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      if (raw.version) return raw.version;
    }
  }
  return "0.0.0";
}

const version = readVersion();

function formatContextBar(
  used: number,
  limit: number,
  compactions?: number,
  quality?: number,
): string {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const barLen = 20;
  const filled = Math.round((pct / 100) * barLen);
  const bar =
    pc.green("█".repeat(filled)) + pc.dim("░".repeat(barLen - filled));
  const pctStr = pct >= 75 ? pc.yellow(`${pct}%`) : pc.dim(`${pct}%`);
  let line = `  ${bar}  ${pctStr}  ${pc.dim(`(${used} / ${limit} tokens)`)}`;
  if (compactions !== undefined) {
    line += pc.dim(`  compactions: ${compactions}`);
  }
  if (quality !== undefined) {
    const qColor =
      quality >= 70 ? pc.green : quality >= 40 ? pc.yellow : pc.red;
    line += `  ${qColor(`quality: ${quality}%`)}`;
  }
  return line;
}

export class Repl implements ReplContext {
  private completer: Completer = new Completer();
  private running = false;
  private agentRunning = false;
  private inputLocked = false;
  private historyPath: string;
  private history: string[] = [];
  private maxHistory = 1000;
  private lastEscTime = 0;
  private readonly doubleEscDelay = 500;
  public readonly configDir: string;
  public readonly baseDir: string;
  private noAgentsMd: boolean;
  private pendingClipboardImage: string | null = null;

  public rl: readline.Interface;
  public agent: Agent;
  public config: AppConfig;
  public sessionManager?: SessionManager;
  public skillsModule?: SkillsModule;
  public pluginManager?: PluginManager;

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

    registerAllCommands(this);
    this.setupCompleter();
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

  public setupCompleter(): void {
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

      if (this.agentRunning || this.inputLocked) {
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
      process.stdin.on("keypress", async (str, key) => {
        if (key.name === "escape") {
          // Bun/Node's readline collapses a fast double-Esc into a single
          // keypress whose `sequence` contains two ESC bytes ("\x1b\x1b").
          // Counting bytes (not events) catches both the collapsed case and
          // the case where two separate escape keypresses land in the window.
          const escBytes = key.sequence
            ? (key.sequence.match(/\x1b/g) || []).length
            : 1;
          const now = Date.now();
          const withinWindow = now - this.lastEscTime < this.doubleEscDelay;
          this.lastEscTime = now;
          if (escBytes >= 2 || withinWindow) {
            this.lastEscTime = 0;
            if (this.agentRunning) {
              process.stdout.write(pc.yellow(`\n${t("repl.interrupt")}\n`));
              this.agent.shutdown();
            }
          }
          return;
        }
        if (key.ctrl && key.name === "v" && !this.agentRunning) {
          try {
            const { readClipboardImage, bufferToDataUrl } =
              await import("../llm/image-utils");
            const clipBuf = await readClipboardImage();
            if (clipBuf) {
              const { dataUrl } = await bufferToDataUrl(clipBuf);
              this.pendingClipboardImage = dataUrl;
              const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
              console.log(
                pc.green(
                  `\n${t("image.attached", { source: "clipboard", size: `${sizeKb} KB` })}`,
                ),
              );
              this.rl.prompt();
            } else {
              console.log(pc.yellow(`\n${t("image.clipboard_empty")}`));
              this.rl.prompt();
            }
          } catch {
            // clipboard read failed — ignore, let terminal paste text normally
          }
        }
      });
    }

    let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

    process.on("SIGINT", () => {
      if (this.agentRunning) {
        console.log(
          pc.yellow("\n[Ctrl+C] Остановка агента... (ещё раз — принудительно)"),
        );
        this.agent.shutdown();
        this.agentRunning = false;
        if (forceExitTimer) clearTimeout(forceExitTimer);
        forceExitTimer = setTimeout(() => process.exit(1), 2000).unref();
      } else {
        process.exit(0);
      }
    });
  }

  private isMultiLineInput(line: string): boolean {
    if (line.endsWith("\\")) return true;

    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    if (openBraces > closeBraces) return true;

    return false;
  }

  public async runAgent(input: string): Promise<void> {
    if (this.agentRunning) return;
    this.agentRunning = true;
    try {
      if (this.pendingClipboardImage) {
        const contextManager = this.agent.contextManager;
        if (contextManager) {
          contextManager.addPendingImage({
            type: "image_url",
            image_url: { url: this.pendingClipboardImage },
          });
        }
        this.pendingClipboardImage = null;
      }

      process.stdout.write("\n" + pc.green(t("repl.agent")));

      const renderer = new Renderer({
        spinner: this.config.ui?.spinner ?? true,
        toolStyle: this.config.ui?.toolStyle ?? "inline",
      });
      const result = await this.agent.run(
        input,
        (c) => renderer.text(c),
        (m) => renderer.meta(m),
        (ev) => {
          if (ev.type === "start") {
            renderer.toolStart(ev.tool, ev.args);
          } else {
            renderer.toolEnd(ev.tool, ev.duration ?? 0, ev.error, ev.ctxDelta);
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
    }
  }

  private commands: Map<string, SlashCommand> = new Map();

  public registerCommand(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.set(alias, cmd);
      }
    }
  }

  public async withExclusiveInput(fn: () => Promise<void>): Promise<void> {
    this.inputLocked = true;
    try {
      await fn();
    } finally {
      this.inputLocked = false;
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

  public showHelp(): void {
    const { COMMAND_GROUPS } =
      require("./repl-commands") as typeof import("./repl-commands");
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
    compactionCount?: number;
    contextQuality?: number;
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
      const ctxLine = formatContextBar(
        result.contextUsed,
        result.contextLimit,
        result.compactionCount,
        result.contextQuality,
      );
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
    const resBudget = Math.floor(
      ctx * this.config.contextBudget.responseReserve,
    );
    const histBudget = ctx - sysBudget - resBudget;

    row(t("repl.model"), pc.white(this.config.model));
    row(
      t("repl.provider"),
      `${this.config.provider.type}  →  ${pc.dim(this.config.provider.baseUrl)}`,
    );
    row(
      t("repl.context"),
      `${pc.white(String(ctx))}  ${pc.dim(`(sys:${sysBudget}  res:${resBudget}  hist:${histBudget})`)}`,
    );

    const si = this.agent.getSystemPromptInfo();
    row(
      t("repl.sysprompt_label"),
      pc.dim(
        t("repl.sysprompt_size", { used: si.tokenCount, budget: sysBudget }),
      ),
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

    const headerWidth = Math.max(
      50,
      Math.min(96, process.stdout.columns || 96),
    );
    for (const line of box(info, {
      title: t("repl.title", { version }),
      width: headerWidth,
    })) {
      console.log(line);
    }
    console.log();
    this.rl.prompt();
  }

  public stop(): void {
    this.running = false;
    this.saveHistory();
    this.agent.shutdown();
    this.rl.close();
  }
}
