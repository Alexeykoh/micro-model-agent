// Интерактивный REPL: ввод, прогоны агента, slash-команды, баннер, история.
// Правило 6: швы — `repl-{history,prompt,keys,completer,run,listeners,dispatch,
// host,session,banner,start,editor,dispatcher}`.
import { join } from "path";
import { homedir } from "os";
import { Completer } from "./completer";
import type { Renderer } from "../ui/renderer";
import type { LineInput } from "../ui/line-editor";
import type { Logger } from "../logger/app-logger";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import { createHostBridge } from "../core/host";
import type { Host, HostCommandResult, HostStateSnapshot } from "../core/host";
import type { HostBridge, HostBridgeSubmitOptions } from "../modules/types";
import type { OutputEvent } from "../output/types";
import type { EnvironmentReport } from "../core/environment";
import { registerAllCommands } from "./repl-commands";
import type { ReplContext, SlashCommand } from "./repl-commands";
import { captureConfigSnapshot } from "../config/registry";
import { SessionLogger } from "../core/session-logger";
import { getDefaultChannel, type SessionOutputSink, type OutputChannel } from "../output";
import type { PromptIO } from "../tools/prompt-io";
import type { ContextProbeResult } from "../llm/model-loader";
import type { ExecutionModule } from "../modules/execution/module";
import { MMA_DIR_NAME } from "../config/paths";
import { createReplEditor } from "./repl-editor";
import {
  attachTerminal,
  inputPrompt,
  presentPrompt,
  withExclusiveInput as runExclusiveInput,
} from "./repl-prompt";
import { createLineDispatcher, isMultiLineInput } from "./repl-dispatcher";
import { setupCompleter as setupReplCompleter, refreshModelCache as refreshReplModelCache } from "./repl-completer";
import { renderPlan, runAgent as runReplAgent } from "./repl-run";
import { setupListeners as setupReplListeners } from "./repl-listeners";
import {
  executeCommandResult as executeReplCommandResult,
  registerCommand as registerReplCommand,
  showHelp as showReplHelp,
} from "./repl-dispatch";
import {
  attachHostBridge as attachReplHostBridge,
  buildLocalHost,
} from "./repl-host";
import { bindSessionOutput, reload as reloadRepl, stop as stopRepl } from "./repl-session";
import { start as startRepl } from "./repl-start";
import { DEFAULT_MAX_HISTORY, loadHistory } from "./repl-history";
import type { CommandInput } from "./command-context";

export { createHostBridge };

/** Интерактивный REPL терминала: владеет stdin, гоняет ходы агента, slash-команды. */
export class Repl implements ReplContext {
  public completer: Completer = new Completer();
  public modelCache: string[] = [];
  /** Boot-снапшот управляемых ключей: `/config reset` откатывает из него. */
  private configSnapshot: ReadonlyMap<string, unknown> = new Map();
  public running = false;
  public agentRunning = false;
  /** Активный рендерер прогона: перемеряет ширину при resize терминала. */
  public activeRenderer: Renderer | null = null;
  public inputLocked = false;
  public historyPath: string;
  public history: string[] = [];
  public maxHistory = DEFAULT_MAX_HISTORY;
  public lastEscTime = 0;
  public readonly doubleEscDelay = 500;
  public readonly configDir: string;
  public readonly baseDir: string;
  public noAgentsMd: boolean;
  public pendingClipboardImage: string | null = null;
  public exitOnClose = false;
  /** Владелец состояния плана (bootstrap). В тестах null — план-UI деградирует. */
  public execModule?: ExecutionModule;
  /** Кадр промпта реально на экране: синк канала активен только тогда (см. `repl-prompt`). */
  public promptPresented = false;
  /** `runAgent` уже вернул промпт — slash-путь не показывает его второй раз. */
  public runHandledPrompt = false;

  public rl: LineInput;
  public agent: Agent;
  public config: AppConfig;
  public sessionManager?: SessionManager;
  public skillsModule?: SkillsModule;
  public pluginManager?: PluginManager;
  public logger?: Logger;
  public slog: SessionLogger;
  /** Расшаренный HostBridge для плагинов и `Host`-поверхности (ленивый, `repl-host`). */
  public hostBridge?: HostBridge;
  /** Персистит `data.persist`-события вывода в активную сессию (`repl-session`). */
  public sessionOutput?: SessionOutputSink;
  public envReport?: EnvironmentReport;
  /** Фоновый пробник реально загруженного контекста модели (bootstrap). */
  public contextProbe?: Promise<ContextProbeResult | null>;
  /** Единый писатель терминала (публичен: `ReplContext.output` для команд). */
  public readonly output: OutputChannel;
  /** Ввод команд (`ctx.input`): адаптер над `askViaEditor` и `rl` (`repl-prompt`). */
  public readonly input: CommandInput;
  /** PromptIO с осознанием терминала, ставится на экзекутор тулов агента. */
  public promptIO: PromptIO;
  public commands: Map<string, SlashCommand> = new Map();
  public lastCompactionShown = 0;

  /** Диспетчер строк (очередь + мультистрочный буфер) — `repl-dispatcher`. */
  public readonly lineDispatcher = createLineDispatcher(this);
  /** Проверка незакрытого многострочного ввода (хвостовой `\` или `{` без `}`). */
  public isMultiLineInput = isMultiLineInput;

  get toolCtx(): import("../tools/types").ToolContext {
    return this.agent.toolContext;
  }

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
    bindSessionOutput(this);
    this.configDir = configDir || join(homedir(), MMA_DIR_NAME);
    this.baseDir = baseDir || process.cwd();
    this.noAgentsMd = noAgentsMd === true;
    this.historyPath = historyPath ?? join(homedir(), ".mma", "repl-history");
    loadHistory(this);

    this.rl = createReplEditor({
      completer: this.completer,
      history: this.history,
      maxHistory: this.maxHistory,
      prompt: inputPrompt(this),
    });

    this.output = output ?? getDefaultChannel();
    // Фронтендовый ввод для команд и промпт-поверхность тулов: `askViaEditor`
    // одалживает терминал под вопрос, `withExclusiveInput` отдаёт его визарду.
    const surfaces = attachTerminal(this);
    this.input = surfaces.input;
    this.promptIO = surfaces.promptIO;

    registerAllCommands(this);
    this.configSnapshot = captureConfigSnapshot(this.config);
    this.setupCompleter();
    setupReplListeners(this);

    // Отдаём агента плагинам (web UI и др.) через узкий мост.
    if (pluginManager) {
      this.attachHostBridge(pluginManager);
    }
  }


  /** (Пере)аттач плагинного HostBridge (в конструкторе и после `/reload`). */
  public attachHostBridge(pm?: PluginManager): void {
    attachReplHostBridge(this, pm);
  }

  /** Перезагрузка агента и модулей (команда /reload). */
  public async reload(): Promise<void> {
    await reloadRepl(this);
  }

  /** Останов REPL: сейв истории, шатдаун агента, закрытие лога сессии. */
  public stop(): void {
    stopRepl(this);
  }

  /** Строит комплитер с нуля. */
  public setupCompleter(): void {
    setupReplCompleter(this);
  }

  /** Перестройка реестра + комплитера — после смены `/config locale`. */
  public reregisterCommands(): void {
    this.commands.clear();
    registerAllCommands(this);
    this.setupCompleter();
  }

  /** Boot-снапшот управляемых ключей для `/config reset`. */
  public getConfigSnapshot(): ReadonlyMap<string, unknown> {
    return this.configSnapshot;
  }

  /** Кешированные id моделей активного провайдера (пусто, пока офлайн). */
  public knownModels(): string[] {
    return this.modelCache;
  }

  /** Фоновое обновление кешированного списка моделей для `/model use <Tab>`. */
  public refreshModelCache(): void {
    refreshReplModelCache(this);
  }

  public presentPrompt(): void {
    presentPrompt(this);
  }

  public afterCommand(): void {
    if (this.runHandledPrompt) {
      this.runHandledPrompt = false;
      return;
    }
    this.presentPrompt();
  }

  /**
   * Эксклюзивный ввод: визард владеет терминалом через свои `rl.question()`.
   * Обобщён, чтобы служить адаптером `CommandInput.withInput` для команд.
   */
  public async withExclusiveInput<T>(fn: () => Promise<T>): Promise<T> {
    return runExclusiveInput(this, fn);
  }


  /** Прогон хода агента: стрим в рендерер, футер, бары, возврат промпта. */
  public async runAgent(input: string): Promise<void> {
    await runReplAgent(this, input);
  }

  /** Печать чеклиста плана (см. `repl-run`). */
  public renderPlan = (renderer: Renderer): void => renderPlan(this, renderer);


  /** Регистрирует slash-команду (имя + алиасы). */
  public registerCommand(cmd: SlashCommand): void {
    registerReplCommand(this, cmd);
  }

  /** Host: прогон slash-команды через ту же handler-map, что и ручной ввод. */
  public executeCommand(line: string): Promise<HostCommandResult> {
    return executeReplCommandResult(this, line);
  }

  /** Показ помощи: общая или по команде (`/help <команда>`). */
  public showHelp(command?: string): void {
    showReplHelp(this, command);
  }

  /** Host/HostBridge: true, пока агент крутит ход. */
  public isBusy(): boolean {
    return this.host.isBusy();
  }

  /** Host/HostBridge: сабмит через общий мост (тот же run-путь). */
  public submit(text: string, opts?: HostBridgeSubmitOptions): Promise<unknown> {
    return this.host.submit(text, opts);
  }

  /** Host/HostBridge: прерывание текущего прогона (в idle — no-op). */
  public interrupt(): void {
    this.host.interrupt();
  }

  /** Host/HostBridge: подписка на общую шину вывода. */
  public subscribeOutput(fn: (ev: OutputEvent) => void): () => void {
    return this.host.subscribeOutput?.(fn) ?? (() => {});
  }

  /** Host-поверхность REPL (`LocalHost`); REPL — потребитель контракта (W1). */
  private localHost?: Host;
  public get host(): Host {
    this.localHost ??= buildLocalHost(this);
    return this.localHost;
  }

  public async getState(sessionId?: string): Promise<HostStateSnapshot> {
    return this.host.getState(sessionId);
  }

  async start(): Promise<void> {
    await startRepl(this);
  }
}
