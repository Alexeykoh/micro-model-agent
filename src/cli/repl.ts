import * as readline from "readline";
import { pc } from "../ui/colors";
import { LineEditor, type LineInput } from "../ui/line-editor";
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
import { divider } from "../ui/box";
import stringWidth from "string-width";
import { t } from "../i18n/index";
import type { Logger } from "../logger/app-logger";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import { registerAllCommands } from "./repl-commands";
import type { ReplContext, SlashCommand } from "./repl-commands";
import { probeLspServers } from "../modules/lsp/probe";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";
import { readActivePlan, formatPlanChecklist, stepContextForTool } from "../ui/plan-view";
import type { Plan } from "../modules/execution/planner";
import { formatCost } from "../modules/pricing/prices";

function formatContextBar(
  used: number,
  limit: number,
  compactions?: number,
  quality?: number,
): string {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const barLen = 20;
  const filled = Math.round((pct / 100) * barLen);
  const bar = pc.green("█".repeat(filled)) + pc.dim("░".repeat(barLen - filled));
  const pctStr = pct >= 75 ? pc.yellow(`${pct}%`) : pc.dim(`${pct}%`);
  let line = `  ${bar}  ${pctStr}  ${pc.dim(`(${used} / ${limit} tokens)`)}`;
  if (compactions !== undefined) {
    line += pc.dim(`  compactions: ${compactions}`);
  }
  if (quality !== undefined) {
    const qColor = quality >= 70 ? pc.green : quality >= 40 ? pc.yellow : pc.red;
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
  private exitOnClose = false;
  private activePlan: Plan | null = null;
  private lastPlanSig = "";

  public rl: LineInput;
  public agent: Agent;
  public config: AppConfig;
  public sessionManager?: SessionManager;
  public skillsModule?: SkillsModule;
  public pluginManager?: PluginManager;
  public logger?: Logger;

  constructor(
    agent: Agent,
    config: AppConfig,
    sessionManager?: SessionManager,
    skillsModule?: SkillsModule,
    pluginManager?: PluginManager,
    configDir?: string,
    baseDir?: string,
    noAgentsMd?: boolean,
    logger?: Logger,
    exitOnClose?: boolean,
  ) {
    this.agent = agent;
    this.config = config;
    this.exitOnClose = exitOnClose === true;
    this.sessionManager = sessionManager;
    this.skillsModule = skillsModule;
    this.pluginManager = pluginManager;
    this.logger = logger;
    this.configDir = configDir || join(homedir(), ".mma");
    this.baseDir = baseDir || process.cwd();
    this.noAgentsMd = noAgentsMd === true;
    this.historyPath = join(homedir(), ".mma", "repl-history");
    this.loadHistory();

    this.rl = process.stdin.isTTY
      ? new LineEditor({
          input: process.stdin,
          output: process.stdout,
          prompt: pc.cyan(t("repl.you")),
          history: this.history,
          historySize: this.maxHistory,
          completer: (line: string) => {
            const [matches, partial] = this.completer.complete(line);
            if (matches.length > 0) return [matches, partial];
            return [[], line];
          },
        })
      : readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: pc.cyan(t("repl.you")),
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
        new SessionNameProvider(() => this.sessionManager!.list().map((s) => s.name)),
      );
    }
    if (this.skillsModule) {
      this.completer.registerProvider(
        new SubcommandProvider("skill", ["list", "loaded", "load", "unload", "search"]),
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
            this.rl.setPrompt(pc.cyan(t("repl.you")));
            this.rl.prompt();
          }
        } else {
          this.rl.setPrompt(pc.cyan(t("repl.you") + "… "));
          this.rl.prompt();
        }
        return;
      }

      if (this.isMultiLineInput(trimmed)) {
        inMultiLine = true;
        multiLineBuffer = trimmed;
        this.rl.setPrompt(pc.cyan(t("repl.you") + "… "));
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
      this.saveHistory();
      this.agent.shutdown();
      // Close session log when REPL exits
      this.logger?.closeSessionLog();
      if (this.exitOnClose) process.exit(0);
    });

    if (this.exitOnClose && !process.stdin.isTTY) {
      process.stdin.on("end", () => {
        this.running = false;
        this.saveHistory();
        this.agent.shutdown();
        // Close session log when REPL exits
        this.logger?.closeSessionLog();
        process.exit(0);
      });
    }

    if (this.rl instanceof LineEditor) {
      this.rl.onKeyInput = (str, key) => this.handleSpecialKey(str, key);
    }

    let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

    process.on("SIGINT", () => {
      if (this.agentRunning) {
        console.log(pc.yellow("\n[Ctrl+C] Остановка агента... (ещё раз — принудительно)"));
        this.agent.shutdown();
        this.agentRunning = false;
        if (forceExitTimer) clearTimeout(forceExitTimer);
        forceExitTimer = setTimeout(() => process.exit(1), 2000).unref();
      } else {
        process.exit(0);
      }
    });
  }

  private handleSpecialKey(str: string, key: any): boolean {
    if (key.name === "escape") {
      // Bun's keypress decoder collapses a fast double-Esc into a single
      // keypress whose `sequence` contains two ESC bytes ("\x1b\x1b").
      // Counting bytes (not events) catches both the collapsed case and
      // the case where two separate escape keypresses land in the window.
      const escBytes = key.sequence ? (key.sequence.match(/\x1b/g) || []).length : 1;
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
      return true;
    }
    if (key.ctrl && key.name === "v" && !this.agentRunning) {
      this.pasteClipboardImage();
      return true;
    }
    return false;
  }

  private async pasteClipboardImage(): Promise<void> {
    try {
      const { readClipboardImage, bufferToDataUrl } = await import("../llm/image-utils");
      const clipBuf = await readClipboardImage();
      if (clipBuf) {
        const { dataUrl } = await bufferToDataUrl(clipBuf);
        this.pendingClipboardImage = dataUrl;
        const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
        console.log(
          pc.green(`\n${t("image.attached", { source: "clipboard", size: `${sizeKb} KB` })}`),
        );
        if (this.rl instanceof LineEditor) this.rl.reset();
        this.rl.prompt();
      } else {
        console.log(pc.yellow(`\n${t("image.clipboard_empty")}`));
        if (this.rl instanceof LineEditor) this.rl.reset();
        this.rl.prompt();
      }
    } catch {
      // clipboard read failed — ignore, let terminal paste text normally
    }
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

      this.logger?.logREPL("user", input);

      if (this.rl instanceof LineEditor) this.rl.reset();
      // Overwrite the empty prompt that reset() just drew with a divider,
      // then label the agent's reply — separates the user's message from
      // the agent's answer.
      process.stdout.write("\r" + divider() + "\n" + pc.green(t("repl.agent")));

      const renderer = new Renderer({
        spinner: this.config.ui?.spinner ?? true,
        toolStyle: this.config.ui?.toolStyle ?? "inline",
      });
      this.refreshActivePlan(renderer);
      const result = await this.agent.run(
        input,
        (c) => renderer.text(c),
        (m) => renderer.meta(m),
        (ev) => {
          if (ev.type === "start") {
            renderer.toolStart(
              ev.tool,
              ev.args,
              stepContextForTool(this.activePlan, ev.tool, ev.args),
              ev.icon,
            );
          } else {
            renderer.toolEnd(ev.tool, ev.duration ?? 0, ev.error, ev.ctxDelta, ev.costUsd);
            if (ev.tool === "plan" || ev.tool === "todo") {
              this.refreshActivePlan(renderer);
            }
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

      this.logger?.logREPL(
        result.success ? "assistant" : "system",
        result.text?.slice(0, 400) || result.error || "",
      );

      if (!result.success) {
        console.error(pc.red(`${t("error.prefix")}${result.error}`));
      }
      this.showContextBar(result);
      // Close the agent's turn: a divider before the next prompt keeps
      // consecutive user/agent messages visually separated.
      process.stdout.write("\n" + divider() + "\n");
    } finally {
      this.agentRunning = false;
    }
  }

  /** Re-read the active plan from disk; print a live checklist when it changed. */
  private refreshActivePlan(renderer: Renderer): void {
    const plan = readActivePlan(this.baseDir);
    const sig = plan ? JSON.stringify(plan.steps.map((s) => `${s.id}:${s.status}`)) : "";
    if (!plan) {
      this.activePlan = null;
      this.lastPlanSig = "";
      return;
    }
    this.activePlan = plan;
    if (sig !== this.lastPlanSig) {
      this.lastPlanSig = sig;
      renderer.planBlock(formatPlanChecklist(plan));
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
    const { COMMAND_GROUPS } = require("./repl-commands") as typeof import("./repl-commands");
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
        const aliases = cmd.aliases?.length ? ` (${pc.dim(cmd.aliases.join(", "))})` : "";
        console.log(`  ${pc.cyan("/" + cmd.name)}${aliases}  ${pc.dim(cmd.description)}`);
        if (cmd.usage) {
          console.log(`    ${pc.dim(cmd.usage)}`);
        }
      }
      console.log();
    }
  }

  private lastCompactionShown = 0;

  private showContextBar(result: {
    contextUsed?: number;
    contextLimit?: number;
    compactionCount?: number;
    contextQuality?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    totalCost?: number;
  }): void {
    if (
      result.contextUsed === undefined ||
      result.contextLimit === undefined ||
      result.contextLimit <= 0
    ) {
      return;
    }

    const ui = this.config.ui;
    if (ui?.showContextStats) {
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
      if (result.totalCost !== undefined && result.totalCost > 0) {
        console.log(pc.yellow(`  ${t("repl.cost", { cost: formatCost(result.totalCost) })}`));
      }
    } else if (ui?.showCompaction && result.compactionCount !== undefined) {
      if (result.compactionCount > this.lastCompactionShown) {
        this.lastCompactionShown = result.compactionCount;
        console.log(pc.dim(`\n  ⟳ Context compacted (${result.compactionCount})`));
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;

    const info: string[] = [];
    const row = (label: string, value: string): void => {
      info.push(` ${pc.yellow(label)} ${value}`);
    };

    const ctx = this.config.contextWindow;
    const sysBudget = Math.floor(ctx * this.config.contextBudget.systemPrompt);
    const resBudget = Math.floor(ctx * this.config.contextBudget.responseReserve);
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
      pc.dim(t("repl.sysprompt_size", { used: si.tokenCount, budget: sysBudget })),
    );

    if (this.skillsModule) {
      const budget = this.skillsModule.getBudget();
      row(
        t("repl.skills_label"),
        `${pc.white(String(this.skillsModule.getAvailable().length))} available, ${pc.dim(`budget: ${budget.total} tokens`)}`,
      );
    }

    if (this.pluginManager) {
      const infos = this.pluginManager.getPluginInfos().filter(({ plugin }) => !plugin.isBuiltin);
      if (infos.length > 0) {
        const pluginNames = infos
          .map(({ plugin, source }) => {
            const version = plugin.version ? `${pc.dim(plugin.version)}` : "";
            const origin = source ? pc.dim(` [${source}]`) : "";
            return `${plugin.name}${version}${origin}`;
          })
          .join(", ");
        row(
          t("repl.plugins_label"),
          `${pc.white(String(infos.length))} active  ${pc.dim(`(${pluginNames})`)}`,
        );
      }
    }

    const mcpServers = this.config.mcpServers || {};
    const enabledServers = Object.entries(mcpServers).filter(([, s]) => s.enabled !== false);
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
    // LSP status is probed in the background — it must never block the banner.
    const isTty = process.stdout.isTTY === true;
    const lspEnabled = isTty && (this.config.lsp ?? DEFAULT_LSP_CONFIG).enabled !== false;
    if (lspEnabled) {
      row(t("repl.lsp_label"), pc.dim("…"));
    }

    // Plain banner without a surrounding box — line-based, wraps to width.
    for (const line of info) {
      console.log(pc.dim(line).trimEnd());
    }
    console.log();
    this.rl.prompt();

    if (lspEnabled) {
      this.probeLspBanner()
        .then((lspSummary) => {
          if (lspSummary) this.updateLspRow(headerWidth, lspSummary);
        })
        .catch(() => {});
    }
  }

  /**
   * Replace the LSP banner row (rendered as "…") in place once the probe
   * finishes. The LSP row is the last data row of the box, so it sits exactly
   * two terminal rows above the prompt line — that offset is stable no matter
   * how earlier rows wrap. Skipped (placeholder stays) when a rewrite would
   * corrupt the screen: the agent is already running, the terminal is not a
   * TTY, a box line wrapped, or the summary is too wide for a single row.
   */
  private updateLspRow(headerWidth: number, summary: string): void {
    if (this.agentRunning || !process.stdout.isTTY) return;
    if ((process.stdout.columns ?? 96) < headerWidth) return;
    const rowText = `${pc.yellow(t("repl.lsp_label"))} ${summary.replace(/\s+/g, " ").trim()}`;
    if (stringWidth(rowText) > headerWidth) return;
    const line = pc.dim(rowText);
    // From the prompt row up 2 to the LSP row (last banner data row, directly
    // above the trailing blank line), clear it, write the new row, and return
    // the cursor to the prompt row. The editor re-positions itself on the next
    // keystroke, so any typed input is preserved.
    process.stdout.write(`\x1b[2A\r\x1b[2K${line}\x1b[2B\r`);
  }

  /**
   * Probe the LSP servers applicable to the current project and format a
   * one-line banner summary, e.g. "✓ typescript (1.2s)" or "✗ css — timeout".
   * Returns null when LSP is disabled or no server applies.
   */
  private async probeLspBanner(): Promise<string | null> {
    const config = this.config.lsp ?? DEFAULT_LSP_CONFIG;
    try {
      const summary = await probeLspServers(config, this.baseDir, { logger: this.logger });
      if (summary.noneApplicable) return null;
      const parts: string[] = [];
      for (const r of summary.ok) {
        parts.push(pc.green(`✓ ${r.language}${pc.dim(` (${(r.durationMs / 1000).toFixed(1)}s)`)}`));
      }
      for (const r of summary.failed) {
        const reason = r.error?.includes("timeout") ? t("repl.lsp_timeout") : t("repl.lsp_failed");
        parts.push(pc.red(`✗ ${r.language}${pc.dim(` — ${reason}`)}`));
      }
      return parts.join("  ");
    } catch {
      return pc.yellow(t("repl.lsp_unknown"));
    }
  }

  public stop(): void {
    this.running = false;
    this.saveHistory();
    this.agent.shutdown();
    // Close session log when REPL stops
    this.logger?.closeSessionLog();
    this.rl.close();
  }
}
