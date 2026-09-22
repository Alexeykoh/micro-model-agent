import * as readline from "readline";
import { pc } from "../ui/colors";
import { LineEditor, type LineInput } from "../ui/line-editor";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import {
  Completer,
  SlashCommandProvider,
  SessionNameProvider,
  SubcommandProvider,
  SkillNameProvider,
  ProviderArgProvider,
  ModelArgProvider,
  type CompletionItem,
} from "./completer";
import { Renderer } from "../ui/renderer";
import { resolveVerbosity, glyph } from "../ui/theme";
import { getLastAction } from "../ui/action-log";
import { divider } from "../ui/box";
import { t } from "../i18n/index";
import type { Logger } from "../logger/app-logger";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import type { HostBridge } from "../modules/types";
import type { EnvironmentReport } from "../core/environment";
import { registerAllCommands } from "./repl-commands";
import type { ReplContext, SlashCommand } from "./repl-commands";
import { probeLspServers } from "../modules/lsp/probe";
import { FileOnlyLogger } from "../modules/lsp/client";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";
import { errMsg } from "../utils";
import { SessionLogger } from "../core/session-logger";
import { formatPlanChecklist, stepContextForTool } from "../ui/plan-view";
import type { ExecutionModule } from "../modules/execution/module";
import { formatCost } from "../modules/pricing/prices";
import { formatCacheLine, type CacheReport } from "./cache-line";
import { probeProviders, targetsFromProviders } from "../modules/providers/health";
import { formatWarning } from "../ui/md-formatter";
import {
  defaultOutputBus,
  getDefaultChannel,
  SessionOutputSink,
  writeNonTtyLine,
  type OutputChannel,
  type PromptSink,
} from "../output";
import { createPromptIO, type PromptIO } from "../tools/prompt-io";
import type { ContextProbeResult } from "../llm/model-loader";

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

/**
 * Build the HostBridge exposed to plugins as `ctx.hostBridge`. Web clients
 * (and any other plugin) submit messages through the SAME runAgent path as
 * terminal input — rendering, session logging and single-flight guard are
 * shared, never duplicated.
 */
export function createHostBridge(opts: {
  isBusy: () => boolean;
  addPendingImage: (dataUrl: string) => void;
  runAgent: (text: string) => Promise<unknown>;
  interruptRun: () => void;
}): HostBridge {
  return {
    isBusy: opts.isBusy,
    async submit(text, o) {
      if (opts.isBusy()) throw new Error("agent is busy");
      for (const url of o?.images ?? []) opts.addPendingImage(url);
      return opts.runAgent(text);
    },
    interrupt() {
      if (opts.isBusy()) opts.interruptRun();
    },
    subscribeOutput: (fn) => defaultOutputBus.subscribe(fn),
  };
}

export class Repl implements ReplContext {
  private completer: Completer = new Completer();
  private modelCache: string[] = [];
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
  /** Owner of plan state (bootstrap). Null in tests — plan UI degrades. */
  private execModule?: ExecutionModule;
  /**
   * True only once the input prompt frame is actually on screen. The channel's
   * prompt sink stays inactive until then, so the startup banner prints plainly
   * instead of erasing/redrawing a frame that was never drawn.
   */
  private promptPresented = false;
  /**
   * Set by `runAgent` so the slash-command path knows the run already restored
   * the prompt and must not present it a second time (e.g. `/run`).
   */
  private runHandledPrompt = false;

  public rl: LineInput;
  public agent: Agent;
  public config: AppConfig;
  public sessionManager?: SessionManager;
  public skillsModule?: SkillsModule;
  public pluginManager?: PluginManager;
  public logger?: Logger;
  private slog: SessionLogger;
  /**
   * Persists `data.persist === true` output events to the active session.
   * Inert until a SessionManager exists; re-bound by `/reload`.
   */
  private sessionOutput?: SessionOutputSink;
  private envReport?: EnvironmentReport;
  /** Background probe of the actually loaded model context (bootstrap). */
  private contextProbe?: Promise<ContextProbeResult | null>;
  /**
   * Single terminal writer for this REPL. Public (not private) because
   * `ReplContext` exposes it to slash commands as `ctx.output`; a private
   * field cannot satisfy a public interface property.
   */
  public readonly output: OutputChannel;
  /** Bridge that lets the channel draw above the live input frame. */
  private promptSink: PromptSink;
  /** Terminal-aware PromptIO installed on the agent's tool executor. */
  private promptIO: PromptIO;

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
    envReport?: EnvironmentReport,
    historyPath?: string,
    execModule?: ExecutionModule,
    contextProbe?: Promise<ContextProbeResult | null>,
    output?: OutputChannel,
  ) {
    this.agent = agent;
    this.config = config;
    this.exitOnClose = exitOnClose === true;
    this.sessionManager = sessionManager;
    this.skillsModule = skillsModule;
    this.pluginManager = pluginManager;
    this.logger = logger;
    this.envReport = envReport;
    this.contextProbe = contextProbe;
    this.execModule = execModule;
    this.slog = new SessionLogger(sessionManager, logger);
    this.bindSessionOutput();
    this.configDir = configDir || join(homedir(), ".mma");
    this.baseDir = baseDir || process.cwd();
    this.noAgentsMd = noAgentsMd === true;
    this.historyPath = historyPath ?? join(homedir(), ".mma", "repl-history");
    this.loadHistory();

    const editorCompleter = (line: string): [CompletionItem[], string] => {
      const [matches, partial] = this.completer.complete(line);
      if (matches.length > 0) return [matches, partial];
      return [[], line];
    };
    // Node readline's completer only understands plain string matches.
    const readlineCompleter = (line: string): [string[], string] => {
      const [items, partial] = editorCompleter(line);
      return [items.map((i) => i.value), partial];
    };

    if (process.stdin.isTTY) {
      this.rl = new LineEditor({
        input: process.stdin,
        output: process.stdout,
        prompt: this.inputPrompt(),
        history: this.history,
        historySize: this.maxHistory,
        completer: editorCompleter,
      });
    } else {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: this.inputPrompt(),
        history: this.history,
        historySize: this.maxHistory,
        tabSize: 2,
        completer: readlineCompleter,
      });
    }

    this.output = output ?? getDefaultChannel();
    this.promptSink = {
      isActive: () =>
        this.rl instanceof LineEditor &&
        this.promptPresented &&
        !this.agentRunning &&
        !this.inputLocked,
      printAbove: (text: string) => {
        if (this.rl instanceof LineEditor) {
          this.rl.printAbove(text);
          return;
        }
        // Non-TTY fallback (readline / piped stdin): no input frame to redraw
        // above, so write directly through the sanctioned machine-output helper
        // — there is no frame for `printAbove` here.
        writeNonTtyLine(text);
      },
      clearScreen: () => {
        if (this.rl instanceof LineEditor) this.rl.clearScreen();
      },
    };
    this.output.attachPrompt(this.promptSink);

    // Terminal-aware prompt surface for interactive tools (question/approve).
    // The REPL owns stdin and is in `streaming` mode during a run, so tools
    // must borrow the editor for a question instead of opening a competing
    // readline that would fight the LineEditor's raw mode.
    this.promptIO = createPromptIO({
      ask: (prompt) => this.askViaEditor(prompt),
      print: (line) => this.output.writeLine(line),
    });
    this.agent.setPromptIO?.(this.promptIO);

    registerAllCommands(this);
    this.setupCompleter();
    this.setupListeners();

    // Expose the agent to plugins (web UI etc.) through a narrow bridge.
    if (pluginManager) {
      this.attachHostBridge(pluginManager);
    }
  }

  /** (Re)attach the plugin HostBridge. Called at construction and after
   *  /reload replaces the PluginManager — without this, a reloaded web-ui
   *  plugin silently loses the ability to submit messages. */
  public attachHostBridge(pm?: PluginManager): void {
    const manager = pm ?? this.pluginManager;
    if (!manager) return;
    manager.setHostBridge(
      createHostBridge({
        isBusy: () => this.agentRunning,
        addPendingImage: (url) => {
          this.agent.contextManager?.addPendingImage?.({
            type: "image_url",
            image_url: { url },
          });
        },
        runAgent: (text) => this.runAgent(text),
        interruptRun: () => this.agent.shutdown(),
      }),
    );
  }

  /** (Re)bind the session output sink after construction or `/reload`. */
  private bindSessionOutput(): void {
    this.sessionOutput?.dispose();
    this.sessionOutput = this.sessionManager
      ? new SessionOutputSink(defaultOutputBus, this.sessionManager)
      : undefined;
  }

  /**
   * Перезагрузка агента и модулей (команда /reload). Живёт здесь, а не в
   * repl-commands, потому что меняет mutable-поля класса — команда через
   * интерфейс только вызывает `ctx.reload()`, не ломая readonly-контракт.
   */
  public async reload(): Promise<void> {
    const { loadConfig } = await import("../config/config");
    const { bootstrap } = await import("../core/bootstrap");

    this.agent.shutdown();

    const projectConfigPath = join(this.baseDir, ".mmrc");
    const { config: freshConfig } = loadConfig({
      configDir: this.configDir,
      projectConfigPath,
    });
    Object.assign(this.config, freshConfig);

    const result = await bootstrap(this.configDir, this.baseDir, false, false);
    this.agent = result.agent;
    // Re-install the prompt surface on the freshly bootstrapped agent — the
    // REPL's `askViaEditor` closure still belongs to this instance.
    this.agent.setPromptIO?.(this.promptIO);
    this.sessionManager = result.sessionManager;
    this.skillsModule = result.skillsModule;
    this.pluginManager = result.pluginManager;
    this.execModule = result.execModule;
    this.bindSessionOutput();

    // Fresh PluginManager has no bridge — re-register it, otherwise plugins
    // like web-ui silently lose control of the agent.
    this.attachHostBridge(result.pluginManager);

    this.setupCompleter();
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
    try {
      // The history dir may be gone (e.g. a temp dir removed during test or
      // session teardown). Recreate it and never let a save throw.
      mkdirSync(dirname(this.historyPath), { recursive: true });
      const allHistory = this.history.slice(-this.maxHistory);
      writeFileSync(this.historyPath, allHistory.join("\n"), "utf-8");
    } catch (e) {
      this.logger?.debug(`Failed to save REPL history: ${(e as Error).message}`);
    }
  }

  public setupCompleter(): void {
    // Rebuild from scratch: /reload calls this again after bootstrap, and
    // re-registering without a reset would duplicate every provider.
    this.completer.reset();
    // `this.commands` is keyed by canonical name AND aliases; iterating its
    // entries yields every completable token, each with its command's
    // description.
    const slashCommands = Array.from(this.commands.entries()).map(([name, cmd]) => ({
      name,
      description: cmd.description,
    }));
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
    // Subcommand + argument completion for provider/model management.
    this.completer.registerProvider(new SubcommandProvider("provider", ["list", "use", "add"]));
    this.completer.registerProvider(new SubcommandProvider("model", ["list", "use"]));
    const entryLabels = this.config.provider?.entries?.map((e) => e.label || e.type) ?? [];
    if (entryLabels.length > 0) {
      this.completer.registerProvider(new ProviderArgProvider(entryLabels));
    }
    this.completer.registerProvider(new ModelArgProvider(() => this.modelCache));
    // Warm the model cache in the background (free listModels call).
    this.refreshModelCache();
  }

  /**
   * Background refresh of the cached model list used by `/model use <Tab>`.
   * Best-effort: on failure the cache keeps its previous contents.
   */
  public refreshModelCache(): void {
    void (async () => {
      try {
        const name =
          this.config.provider.active ||
          this.config.provider.entries?.[0]?.label ||
          this.config.provider.type;
        const provider = this.agent.getProviderFor(name);
        if (!provider) return;
        const models = await provider.listModels();
        if (models.length > 0) {
          this.modelCache = models.sort();
        }
      } catch {
        // keep previous cache
      }
    })();
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
              this.afterCommand();
            } else {
              await this.runAgent(fullInput);
            }
          }
        } else {
          this.rl.setPrompt(this.inputPrompt(true));
          this.rl.prompt();
        }
        return;
      }

      if (this.isMultiLineInput(trimmed)) {
        inMultiLine = true;
        multiLineBuffer = trimmed;
        this.rl.setPrompt(this.inputPrompt(true));
        this.rl.prompt();
        return;
      }

      if (!trimmed) {
        this.rl.setPrompt(this.inputPrompt());
        this.rl.prompt();
        return;
      }

      if (trimmed.startsWith("/")) {
        await this.executeCommand(trimmed);
        this.afterCommand();
      } else {
        await this.runAgent(trimmed);
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
    // Запас на очистку (сессия, MCP, дочерние процессы) после второго Ctrl+C.
    const FORCE_EXIT_MS = 5000;

    // Idempotent registration: a second Repl in the same process must not add
    // another global SIGINT handler. Leaked handlers from REPL instances
    // created in tests fired process.exit(0) on ANY process.emit("SIGINT")
    // elsewhere and silently terminated the whole bun test runner.
    if (typeof (Repl as any).sigintHandler === "function") {
      process.removeListener("SIGINT", (Repl as any).sigintHandler);
    }
    (Repl as any).sigintHandler = () => {
      if (this.agentRunning) {
        this.output.writeLine(pc.yellow(t("repl.ctrl_c_interrupt")));
        this.agent.shutdown();
        this.agentRunning = false;
        if (forceExitTimer) clearTimeout(forceExitTimer);
        forceExitTimer = setTimeout(() => {
          this.output.writeLine(pc.yellow(t("repl.force_exit")));
          process.exit(1);
        }, FORCE_EXIT_MS).unref();
      } else {
        process.exit(0);
      }
    };
    process.on("SIGINT", (Repl as any).sigintHandler);
  }

  /**
   * Re-present the input prompt after a slash command. Commands do not own a
   * frame lifecycle, so they need this explicit redraw. The agent path is
   * deliberately excluded: `runAgent`'s finally calls `LineEditor.resumeFrame()`
   * as its single prompt presentation, so prompting here again would double-draw.
   */
  private presentPrompt(): void {
    if (!this.running) return;
    this.rl.setPrompt(this.inputPrompt());
    this.rl.prompt();
    this.promptPresented = true;
  }

  /**
   * Reasoning label shown in the input prompt. In `auto` mode the effective
   * level is normally decided per iteration by the policy, so we show only the
   * fact that reasoning is automatic. If the user set an explicit override
   * (`/reasoning <level>`, persistent) or the agent set a still-active
   * `set_thinking` override (transient), we show `auto→<level>`. In a fixed
   * mode we show the effective level.
   */
  private reasoningLabel(): string {
    const mode = this.config.reasoning?.mode ?? "default";
    if (mode !== "auto") return this.agent.reasoningLevel ?? mode;
    const rs = this.agent.reasoningState;
    const cooldown = this.config.reasoning?.overrideCooldown ?? 0;
    const transientActive =
      rs.overrideIteration >= 0 && this.agent.currentIteration - rs.overrideIteration <= cooldown;
    if (rs.manual || transientActive) return `auto→${this.agent.reasoningLevel}`;
    return "auto";
  }

  /** Localized input prompt embedding the active reasoning mode/level. */
  private inputPrompt(continuation = false): string {
    const key = continuation ? "repl.you_reasoning_cont" : "repl.you_reasoning";
    return pc.cyan(t(key, { level: this.reasoningLabel() }));
  }

  /**
   * Prompt bookkeeping after a slash command. A command that drove a run
   * (e.g. `/run`) already had its prompt restored by `runAgent`; presenting
   * again would double-render, so skip it exactly once. All other commands
   * present the prompt here.
   */
  private afterCommand(): void {
    if (this.runHandledPrompt) {
      this.runHandledPrompt = false;
      return;
    }
    this.presentPrompt();
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
          this.output.writeLine(pc.yellow(`\n${t("repl.interrupt")}`));
          this.agent.shutdown();
        }
      }
      return true;
    }
    if (key.ctrl && key.name === "v" && !this.agentRunning) {
      this.pasteClipboardImage();
      return true;
    }
    if (key.ctrl && key.name === "o" && !this.agentRunning) {
      this.reprintLastAction();
      return true;
    }
    return false;
  }

  /** Ctrl+O — reprint the full detail of the most recent action. */
  private reprintLastAction(): void {
    const last = getLastAction();
    if (!last) {
      this.output.writeLine(pc.dim(t("repl.last_action_none")));
      return;
    }
    const mark =
      last.status === "error"
        ? pc.red(glyph.failure)
        : last.status === "warn"
          ? pc.yellow(glyph.warning)
          : pc.green(glyph.success);
    const head = `${pc.cyan(glyph.action)} ${last.label}${
      last.args ? ` ${pc.dim(last.args)}` : ""
    }  ${mark} ${pc.dim(`${last.durationMs}ms`)}`;
    const lines = [head, ...last.body.map((l) => `  ${l}`)];
    this.output.writeLine(`\n${lines.join("\n")}`);
    if (this.rl instanceof LineEditor) {
      this.rl.reset();
      this.rl.prompt();
    }
  }

  private async pasteClipboardImage(): Promise<void> {
    try {
      const { readClipboardImage, bufferToDataUrl } = await import("../llm/image-utils");
      const clipBuf = await readClipboardImage();
      if (clipBuf) {
        const { dataUrl } = await bufferToDataUrl(clipBuf);
        this.pendingClipboardImage = dataUrl;
        const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
        this.output.writeLine(
          pc.green(`\n${t("image.attached", { source: "clipboard", size: `${sizeKb} KB` })}`),
        );
        if (this.rl instanceof LineEditor) this.rl.reset();
        this.rl.prompt();
      } else {
        this.output.writeLine(pc.yellow(`\n${t("image.clipboard_empty")}`));
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

      // The prompt frame is about to be taken down; deactivate the sink before
      // any streamed output so nothing tries to draw above it.
      this.promptPresented = false;
      // Hand the terminal to the channel for the duration of the run: the
      // editor stops drawing its frame and ignores typed keys, so streamed
      // output cannot corrupt the input line. suspendFrame() runs before
      // reset(), which would otherwise draw a frame only to erase it.
      if (this.rl instanceof LineEditor) {
        this.rl.suspendFrame();
        this.rl.setInputEnabled(false);
        this.rl.reset();
      }
      this.output.beginStreaming();
      // Divider + agent label, written raw (no trailing newline): the next
      // Renderer.text() chunk adds its own leading "\n" so a writeLine here
      // would insert a blank line ("Agent:\n\n...").
      this.output.writeRaw(`\r${divider()}\n${pc.green(t("repl.agent"))}`);

      const renderer = new Renderer({
        spinner: this.config.ui?.spinner ?? true,
        baseDir: this.baseDir,
        channel: this.output,
        verbosity: resolveVerbosity(this.config.ui),
      });
      renderer.showLoader();
      const result = await this.agent.run(
        input,
        (c) => renderer.text(c),
        (m) => renderer.meta(m),
        (ev) => {
          if (ev.type === "start") {
            renderer.toolStart(
              ev.tool,
              ev.args,
              stepContextForTool(this.execModule?.getActivePlan() ?? null, ev.tool, ev.args),
              ev.icon,
            );
          } else {
            renderer.toolEnd(ev.tool, ev.duration ?? 0, ev.error, ev.ctxDelta, ev.costUsd);
            if (ev.tool === "plan" || ev.tool === "todo") {
              this.renderPlan(renderer);
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
      if (result.provider && result.model) {
        renderer.footer(
          result.model,
          result.provider,
          result.llmDurationMs ?? result.durationMs ?? 0,
        );
      }
      this.output.writeLine("");

      this.logger?.logREPL(
        result.success ? "assistant" : "system",
        result.text?.slice(0, 400) || result.error || "",
      );

      if (!result.success) {
        this.output.writeLine(pc.red(`${t("error.prefix")}${result.error}`), "stderr");
      }
      this.showContextBar(result);
      // Close the agent's turn: a divider before the next prompt keeps
      // consecutive user/agent messages visually separated.
      this.output.writeLine(`\n${divider()}`);
    } finally {
      this.agentRunning = false;
      this.output.endStreaming();
      if (this.rl instanceof LineEditor) {
        this.rl.setInputEnabled(true);
        // Single prompt presentation for the agent path: resumeFrame()
        // redraws the frame, so the `line` listener must NOT prompt again
        // after runAgent() (it still does after slash commands).
        // Re-set the prompt first so a reasoning level changed by
        // set_thinking during the run is reflected on the resumed frame.
        this.rl.setPrompt(this.inputPrompt());
        this.rl.resumeFrame();
        this.promptPresented = true;
      } else {
        // Piped/non-TTY fallback has no frame to resume; present the readline
        // prompt here to preserve the old post-run behavior.
        this.presentPrompt();
      }
      this.runHandledPrompt = true;
    }
  }

  /** Print the checklist of the plan currently tracked by ExecutionModule.
   *  Called only on plan/todo tool events (a change event) — never polled,
   *  so a disk-resident plan from a previous session cannot leak into chat. */
  private renderPlan(renderer: Renderer): void {
    const plan = this.execModule?.getActivePlan();
    if (!plan) return;
    renderer.planBlock(formatPlanChecklist(plan));
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
    // The wizard owns the terminal through its own `rl.question()` calls. Between
    // questions no frame is active, so its menus/scan results must be written
    // directly — bracketing with beginModal/endModal would QUEUE the whole
    // transcript and the user would only see bare `: ` prompts until completion.
    // `inputLocked` makes `promptSink.isActive()` false, routing writes direct.
    this.inputLocked = true;
    try {
      await fn();
    } finally {
      this.inputLocked = false;
    }
  }

  /**
   * Borrow the terminal for one interactive-tool question and hand it back.
   * During a run the LineEditor is suspended with input disabled; enabling
   * input + resuming the frame lets `question()` read keys while the agent
   * blocks, and the `finally` restores exactly the streaming state so the
   * agent's own renderer keeps working afterwards.
   *
   * Order matters: `beginModal()` first flushes any output still buffered by
   * the streaming channel so it prints plainly before the frame returns;
   * `endModal()` runs only after the frame is suspended again, so events
   * queued during the question flush plainly instead of corrupting the frame.
   */
  private async askViaEditor(prompt: string): Promise<string> {
    const editor = this.rl instanceof LineEditor ? this.rl : null;
    const wasSuspended = editor ? editor.isFrameSuspended() : true;
    const wasEnabled = editor ? editor.isInputEnabled() : false;
    this.output.beginModal();
    if (editor) {
      editor.setInputEnabled(true);
      editor.resumeFrame();
    }
    try {
      return await new Promise<string>((resolve) => this.rl.question(prompt, resolve));
    } finally {
      if (editor) {
        editor.setInputEnabled(wasEnabled);
        if (wasSuspended) editor.suspendFrame();
        else editor.resumeFrame();
      }
      this.output.endModal();
    }
  }

  private async executeCommand(input: string): Promise<void> {
    const parts = input.split(/\s+/);
    const name = parts[0].slice(1);
    const args = parts.slice(1);

    // Clear any stale run flag from a previous direct agent run so this
    // command's own presentPrompt() decision is based on its own action.
    this.runHandledPrompt = false;

    const cmd = this.commands.get(name);
    if (!cmd) {
      this.output.writeLine(`${pc.red(t("cli.unknown_cmd", { name }))} ${t("cli.help_hint")}`);
      return;
    }

    try {
      await cmd.action(args);
    } catch (err) {
      this.output.writeLine(
        pc.red(
          t("error.command_error", {
            message: errMsg(err),
          }),
        ),
        "stderr",
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

      this.output.writeLine(pc.bold(t(`repl.group.${groupKey}`)));
      for (const cmd of cmds) {
        const aliases = cmd.aliases?.length ? ` (${pc.dim(cmd.aliases.join(", "))})` : "";
        this.output.writeLine(`  ${pc.cyan("/" + cmd.name)}${aliases}  ${pc.dim(cmd.description)}`);
        if (cmd.usage) {
          this.output.writeLine(`    ${pc.dim(cmd.usage)}`);
        }
      }
      this.output.writeLine("");
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
    cache?: CacheReport;
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
      this.output.writeLine("");
      const ctxLine = formatContextBar(
        result.contextUsed,
        result.contextLimit,
        result.compactionCount,
        result.contextQuality,
      );
      this.output.writeLine(ctxLine);
      if (result.totalTokens !== undefined && result.totalTokens > 0) {
        const apiLine = pc.dim(
          `  API: ${result.promptTokens} prompt + ${result.completionTokens} completion = ${result.totalTokens} total`,
        );
        this.output.writeLine(apiLine);
      }
      if (result.totalCost !== undefined && result.totalCost > 0) {
        this.output.writeLine(
          pc.yellow(`  ${t("repl.cost", { cost: formatCost(result.totalCost) })}`),
        );
      }
      const cacheLine = formatCacheLine(result.cache);
      if (cacheLine) {
        this.output.writeLine(pc.dim(`  ${cacheLine}`));
      }
    } else if (ui?.showCompaction && result.compactionCount !== undefined) {
      if (result.compactionCount > this.lastCompactionShown) {
        this.lastCompactionShown = result.compactionCount;
        this.output.writeLine(pc.dim(`\n  ⟳ Context compacted (${result.compactionCount})`));
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

    // Show the agent's workspace (the `-d` dir), not the process cwd: `bun run`
    // sets cwd to the package root, which is NOT where the agent operates.
    row(t("repl.work_dir"), pc.dim(this.baseDir));

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

    // LSP status is probed in the background — it must never block the banner.
    const isTty = process.stdout.isTTY === true;
    const lspEnabled = isTty && (this.config.lsp ?? DEFAULT_LSP_CONFIG).enabled !== false;

    // Plain banner without a surrounding box — line-based, wraps to width.
    for (const line of info) {
      this.output.writeLine(pc.dim(line).trimEnd());
    }
    this.output.writeLine("");

    // Legacy config hint
    try {
      const { existsSync: exists } = await import("fs");
      const { join: pathJoin } = await import("path");
      const { hasDomainFiles } = await import("../config/domains");
      const legacyPath = pathJoin(this.configDir, "config.json");
      if (exists(legacyPath) && !hasDomainFiles(this.configDir)) {
        this.output.writeLine(pc.yellow(`  ${t("config.legacy_hint")}`));
        this.output.writeLine("");
      }
    } catch {}

    // Single prompt presentation for startup: the banner above was written
    // plainly (promptPresented was false), so no frame needs erasing here.
    this.rl.prompt();
    this.promptPresented = true;

    if (lspEnabled) {
      this.probeLspBanner()
        .then((lspSummary) => {
          if (lspSummary) {
            const line = `${pc.green(t("repl.agent"))}${pc.yellow(t("repl.lsp_label"))} ${lspSummary}`;
            // Channel owns the prompt row now: no manual erase + prompt() hack.
            this.output.writeLine(`${divider()}\n${line}`);
          }
        })
        .catch(() => {});
    }

    if ((this.config.provider.entries?.length ?? 0) > 1) {
      // Phase 4.4: background health probe of all entries (free listModels
      // calls). Failed providers are surfaced as warnings — failover (Phase
      // 4.2) would silently mask a dead primary.
      void probeProviders(
        targetsFromProviders(
          (this.config.provider.entries ?? [])
            .map((e) => ({
              name: e.label || e.type,
              provider: this.agent.getProviderFor(e.label || e.type),
            }))
            .filter((x): x is { name: string; provider: NonNullable<typeof x.provider> } =>
              Boolean(x.provider),
            ),
        ),
        { timeoutMs: 5000 },
      )
        .then((results) => {
          for (const r of results) {
            if (!r.ok && r.name !== this.config.provider.active) {
              this.output.writeLine(
                formatWarning(t("repl.provider_down", { name: r.name, error: r.error ?? "" })),
              );
            }
          }
        })
        .catch(() => {});
    }

    // Context probe (background): compare the context length the model is
    // actually loaded with against the configured window. Same non-blocking
    // banner pattern as the LSP probe above.
    if (this.contextProbe) {
      void this.contextProbe
        .then((probe) => {
          if (!probe) return;
          // The probe entry is persisted by bootstrap (all modes); here we only
          // render the banner line.
          const line =
            probe.actual < this.config.contextWindow
              ? `${pc.yellow("⚠")} ${t("repl.context_probe_small", { model: probe.model, actual: probe.actual, configured: this.config.contextWindow })}`
              : probe.actual > this.config.contextWindow
                ? `${pc.dim(t("repl.context_probe_big", { model: probe.model, actual: probe.actual }))}`
                : null;
          if (line) {
            // Channel owns the prompt row now: no manual erase + prompt() hack.
            this.output.writeLine(`${divider()}\n${line}`);
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Probe the LSP servers applicable to the current project and format a
   * one-line banner summary, e.g. "✓ typescript (1.2s)" or "✗ css — timeout".
   * Returns null when LSP is disabled or no server applies.
   */
  private async probeLspBanner(): Promise<string | null> {
    const config = this.config.lsp ?? DEFAULT_LSP_CONFIG;
    try {
      const lspOnlyLogger = this.logger ? new FileOnlyLogger(this.logger) : undefined;
      const summary = await probeLspServers(config, this.baseDir, { logger: lspOnlyLogger });
      // Log LSP probe results to session for post-mortem visibility
      this.slog.logSessionStart({
        environment: this.envReport as unknown as Record<string, unknown>,
        lspProbe: {
          ok: summary.ok.map((r) => ({ language: r.language, durationMs: r.durationMs })),
          failed: summary.failed.map((r) => ({
            language: r.language,
            error: r.error,
            durationMs: r.durationMs,
          })),
          noneApplicable: summary.noneApplicable,
        },
      });
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
    this.sessionOutput?.dispose();
    this.sessionOutput = undefined;
    // Close session log when REPL stops
    this.logger?.closeSessionLog();
    this.rl.close();
  }
}
