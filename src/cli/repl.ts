// Интерактивный REPL: ввод, прогоны агента, slash-команды, баннер, история.
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
  FilePathProvider,
  ConfigKeyProvider,
  ConfigValueProvider,
  FlagProvider,
  CommandArgProvider,
  buildSlashCompletions,
  type CompletionItem,
} from "./completer";
import { Renderer } from "../ui/renderer";
import { resolveVerbosity, glyph, toolAccent } from "../ui/theme";
import { getLastAction } from "../ui/action-log";
import { divider } from "../ui/box";
import { t } from "../i18n/index";
import type { Logger } from "../logger/app-logger";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import { createHostBridge } from "../core/host";
import type { Host, HostStateSnapshot } from "../core/host";
import type { HostBridge, HostBridgeSubmitOptions } from "../modules/types";
import type { OutputEvent } from "../output/types";
import { planSnapshotFromModule, adaptActivePlan } from "../core/host-plan";
import type { EnvironmentReport } from "../core/environment";
import { registerAllCommands } from "./repl-commands";
import type { ReplContext, SlashCommand } from "./repl-commands";
import { captureConfigSnapshot } from "../config/registry";
import { activeProviderEndpoint } from "../modules/providers/manager";
import { probeLspServers } from "../modules/lsp/probe";
import { FileOnlyLogger } from "../modules/lsp/client";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";
import { errMsg } from "../utils";
import { SessionLogger } from "../core/session-logger";
import { exitMeetMode } from "../modules/onboarding/mode";
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
import { MMA_DIR_NAME, projectMmaDir } from "../config/paths";
import { MMA_ENV, readEnv } from "../config/env";

/** Рендерит бар использования контекста с компакциями и качеством. */
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

export { createHostBridge };

/** Интерактивный REPL терминала: владеет stdin, гоняет ходы агента, slash-команды. */
export class Repl implements ReplContext, Host {
  /** Глобальный SIGINT-хендлер, общий на все инстансы Repl (см. registerSigint). */
  private static sigintHandler?: () => void;
  private completer: Completer = new Completer();
  private modelCache: string[] = [];
  /** Boot-снапшот управляемых ключей: `/config reset` откатывает из него. */
  private configSnapshot: ReadonlyMap<string, unknown> = new Map();
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
  /** Владелец состояния плана (bootstrap). В тестах null — план-UI деградирует. */
  private execModule?: ExecutionModule;
  /**
   * True, лишь когда кадр промпта ввода реально на экране. Промпт-синк канала
   * неактивен до тех пор, чтобы стартовый баннер печатался plain, а не стирал/
   * перерисовывал никогда не рисованный кадр.
   */
  private promptPresented = false;
  /**
   * Ставит `runAgent`, чтобы slash-путь знал: прогон уже вернул промпт и второй
   * раз его показывать нельзя (напр. `/run`).
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
   * Расшаренный инстанс HostBridge (для плагинов; заодно движок `Host`-поверхности).
   * Лениво строится, если PluginManager не аттачили.
   */
  private hostBridge?: HostBridge;
  /**
   * Персистит события вывода с `data.persist === true` в активную сессию.
   * Инертен, пока нет SessionManager; перепривязывается через `/reload`.
   */
  private sessionOutput?: SessionOutputSink;
  private envReport?: EnvironmentReport;
  /** Фоновый пробник реально загруженного контекста модели (bootstrap). */
  private contextProbe?: Promise<ContextProbeResult | null>;
  /**
   * Единый писатель терминала этого REPL. Публичен (не private), потому что
   * `ReplContext` отдаёт его slash-командам как `ctx.output`; private-поле не
   * удовлетворило бы публичному свойству интерфейса.
   */
  public readonly output: OutputChannel;
  /** Мост, дающий каналу рисовать поверх живого кадра ввода. */
  private promptSink: PromptSink;
  /** PromptIO с осознанием терминала, ставится на экзекутор тулов агента. */
  private promptIO: PromptIO;

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
    this.bindSessionOutput();
    this.configDir = configDir || join(homedir(), MMA_DIR_NAME);
    this.baseDir = baseDir || process.cwd();
    this.noAgentsMd = noAgentsMd === true;
    this.historyPath = historyPath ?? join(homedir(), ".mma", "repl-history");
    this.loadHistory();

    const editorCompleter = (line: string): [CompletionItem[], string] => {
      const [matches, partial] = this.completer.complete(line);
      if (matches.length > 0) return [matches, partial];
      return [[], line];
    };
    // Комплитер node-readline понимает только plain-строковые совпадения.
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
        // Не-TTY фолбэк (readline / пайпнутый stdin): кадра ввода для перерисовки
        // сверху нет — пишем напрямую через санкционированный машинный хелпер:
        // `printAbove` здесь не про что.
        writeNonTtyLine(text);
      },
      clearScreen: () => {
        if (this.rl instanceof LineEditor) this.rl.clearScreen();
      },
    };
    this.output.attachPrompt(this.promptSink);

    // Промпт-поверхность с осознанием терминала для интерактивных тулов (question/approve).
    // stdin владеет REPL и на время прогона он в `streaming`: тулы обязаны одалживать
    // редактор под вопрос, а не открывать конкурирующий readline, который подерётся
    // с raw-режимом LineEditor.
    this.promptIO = createPromptIO({
      ask: (prompt) => this.askViaEditor(prompt),
      print: (line) => this.output.writeLine(line),
    });
    this.agent.setPromptIO?.(this.promptIO);

    registerAllCommands(this);
    this.configSnapshot = captureConfigSnapshot(this.config);
    this.setupCompleter();
    this.setupListeners();

    // Отдаём агента плагинам (web UI и др.) через узкий мост.
    if (pluginManager) {
      this.attachHostBridge(pluginManager);
    }
  }

  /** (Пере)аттач плагинного HostBridge. Зовётся в конструкторе и после того, как
   *  /reload заменил PluginManager: без этого перезагруженный web-ui плагин
   *  молча теряет способность сабмитить сообщения. */
  public attachHostBridge(pm?: PluginManager): void {
    const manager = pm ?? this.pluginManager;
    if (!manager) return;
    this.hostBridge ??= this.buildHostBridge();
    manager.setHostBridge(this.hostBridge);
  }

  /** Единый busy-предикат для `Host`-поверхности и моста. */
  private isAgentBusy(): boolean {
    return this.agentRunning;
  }

  /** Строит HostBridge поверх обычного run-пути этого REPL. */
  private buildHostBridge(): HostBridge {
    return createHostBridge({
      isBusy: () => this.isAgentBusy(),
      addPendingImage: (url) => {
        this.agent.contextManager?.addPendingImage?.({
          type: "image_url",
          image_url: { url },
        });
      },
      runAgent: (text) => this.runAgent(text),
      interruptRun: () => this.agent.shutdown(),
    });
  }

  /** Лениво резолвит общий мост, чтобы `Host`-методы работали без плагинов. */
  private getHostBridge(): HostBridge {
    this.hostBridge ??= this.buildHostBridge();
    return this.hostBridge;
  }

  /** (Пере)привязка синка вывода сессии после конструктора или `/reload`. */
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
    // Переустанавливаем промпт-поверхность на свежезабутстрапленного агента: замыкание
    // `askViaEditor` этого REPL принадлежит всё ещё этому инстансу.
    this.agent.setPromptIO?.(this.promptIO);
    this.sessionManager = result.sessionManager;
    this.skillsModule = result.skillsModule;
    this.pluginManager = result.pluginManager;
    this.execModule = result.execModule;
    this.bindSessionOutput();

    // У свежего PluginManager моста нет — перерегистрируем, иначе плагины вроде
    // web-ui молча теряют управление агентом.
    this.attachHostBridge(result.pluginManager);

    this.setupCompleter();
  }

  /** Грузит историю ввода из файла. */
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

  /** Сохраняет историю ввода. Падение каталога переживает молча, не бросает. */
  private saveHistory(): void {
    try {
      // Каталога истории может не быть (напр. temp снесли в тесте или при teardown
      // сессии). Пересоздаём; сейв бросать не должен никогда.
      mkdirSync(dirname(this.historyPath), { recursive: true });
      const allHistory = this.history.slice(-this.maxHistory);
      writeFileSync(this.historyPath, allHistory.join("\n"), "utf-8");
    } catch (e) {
      this.logger?.debug(`Failed to save REPL history: ${(e as Error).message}`);
    }
  }

  /** Строит комплитер с нуля. */
  public setupCompleter(): void {
    // Пересборка с нуля: /reload зовёт снова после bootstrap, и перерегистрация
    // без reset дублировала бы каждого провайдера.
    this.completer.reset();
    // `this.commands` ключуется каноническими именами И алиасами; итерация даёт
    // каждый дополняемый токен с описанием его команды.
    const slashCommands = buildSlashCompletions(this.commands);
    this.completer.registerProvider(new SlashCommandProvider(slashCommands));
    if (this.sessionManager) {
      this.completer.registerProvider(
        new SessionNameProvider(() => this.sessionManager!.list().map((s) => s.name), [
          "/resume",
          "/delete",
          "/export",
        ]),
      );
    }
    if (this.skillsModule) {
      this.completer.registerProvider(
        new SubcommandProvider("skill", [
          { name: "list", description: t("skill.sub_list") },
          { name: "loaded", description: t("skill.sub_loaded") },
          { name: "load", description: t("skill.sub_load") },
          { name: "unload", description: t("skill.sub_unload") },
          { name: "search", description: t("skill.sub_search") },
        ]),
      );
      this.completer.registerProvider(new SkillNameProvider(this.skillsModule));
    }
    // Комплит субкоманд + аргументов управления provider/model.
    this.completer.registerProvider(
      new SubcommandProvider("provider", [
        { name: "list", description: t("provider.sub_list") },
        { name: "use", description: t("provider.sub_use") },
        { name: "add", description: t("provider.sub_add") },
      ]),
    );
    this.completer.registerProvider(
      new SubcommandProvider("model", [
        { name: "list", description: t("model.sub_list") },
        { name: "use", description: t("model.sub_use") },
      ]),
    );
    this.completer.registerProvider(
      new SubcommandProvider("map", [
        { name: "summary", description: t("map.sub_summary") },
        { name: "refresh", description: t("map.sub_refresh") },
        { name: "find", description: t("map.sub_find") },
      ]),
    );
    this.completer.registerProvider(
      new SubcommandProvider("context", [
        { name: "system", description: t("context.sub_system") },
        { name: "reserve", description: t("context.sub_reserve") },
      ]),
    );
    this.completer.registerProvider(
      new SubcommandProvider("lsp", [
        { name: "status", description: t("lsp.sub_status") },
        { name: "restart", description: t("lsp.sub_restart") },
        { name: "doctor", description: t("lsp.sub_doctor") },
        { name: "check", description: t("lsp.sub_check") },
      ]),
    );
    this.completer.registerProvider(
      new SubcommandProvider("reasoning", [
        { name: "show", description: t("reasoning.sub_show") },
        { name: "hide", description: t("reasoning.sub_hide") },
        { name: "level", description: t("reasoning.sub_level") },
      ]),
    );
    this.completer.registerProvider(
      new SubcommandProvider("verbose", [
        { name: "quiet", description: t("verbose.sub_quiet") },
        { name: "normal", description: t("verbose.sub_normal") },
        { name: "verbose", description: t("verbose.sub_verbose") },
      ]),
    );
    this.completer.registerProvider(
      new SubcommandProvider("security", [
        { name: "status", description: t("cli.security.status") },
      ]),
    );
    this.completer.registerProvider(new ConfigKeyProvider());
    this.completer.registerProvider(new ConfigValueProvider());
    this.completer.registerProvider(new FlagProvider());
    this.completer.registerProvider(
      new CommandArgProvider(() =>
        Array.from(this.commands.entries())
          .filter(([key, cmd]) => key === cmd.name)
          .map(([, cmd]) => cmd.name),
      ),
    );
    const entryLabels = this.config.provider?.entries?.map((e) => e.label || e.type) ?? [];
    if (entryLabels.length > 0) {
      this.completer.registerProvider(new ProviderArgProvider(entryLabels));
    }
    this.completer.registerProvider(new ModelArgProvider(() => this.modelCache));
    // Комплит путей якорится на workspace агента, а не process.cwd().
    this.completer.registerProvider(new FilePathProvider(this.baseDir));
    // Греем кеш моделей фоном (бесплатный listModels-вызов).
    this.refreshModelCache();
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

  /**
   * Фоновое обновление кешированного списка моделей для `/model use <Tab>`.
   * Best-effort: при провале кеш хранит прошлое содержимое.
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
        multiLineBuffer += `\n${line}`;
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
      // Закрываем лог сессии на выходе из REPL.
      this.logger?.closeSessionLog();
      if (this.exitOnClose) process.exit(0);
    });

    if (this.exitOnClose && !process.stdin.isTTY) {
      process.stdin.on("end", () => {
        this.running = false;
        this.saveHistory();
        this.agent.shutdown();
        // Закрываем лог сессии на выходе из REPL.
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

    // Идемпотентная регистрация: второй Repl в том же процессе не добавляет
    // ещё один глобальный SIGINT-хендлер. Протёкшие хендлеры инстансов REPL,
    // созданные в тестах, стреляли process.exit(0) на ЛЮБОЙ process.emit("SIGINT")
    // в другом месте и молча убивали весь bun-раннер тестов.
    if (typeof Repl.sigintHandler === "function") {
      process.removeListener("SIGINT", Repl.sigintHandler);
    }
    Repl.sigintHandler = () => {
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
    process.on("SIGINT", Repl.sigintHandler);
  }

  /**
   * Перепоказ промпта ввода после slash-команды. У команд нет владения жизненным
   * циклом кадра, им нужна явная перерисовка. Путь агента осознанно исключён:
   * finally `runAgent` зовёт `LineEditor.resumeFrame()` как единственный показ —
   * промпт здесь дал бы двойную отрисовку.
   */
  private presentPrompt(): void {
    if (!this.running) return;
    this.rl.setPrompt(this.inputPrompt());
    this.rl.prompt();
    this.promptPresented = true;
  }

  /** Возврат обычного промпта после стартового вопроса, если активен LineEditor. */
  private restoreStartupPrompt(): void {
    if (this.rl instanceof LineEditor) {
      this.rl.setPrompt(this.inputPrompt());
      this.rl.prompt();
      this.promptPresented = true;
    }
  }

  /**
   * Ярлык reasoning в промпте ввода. В `auto` эффективный уровень обычно решает
   * политика поитерационно, так что показываем лишь факт автоматики. При явном
   * оверрайде юзера (`/reasoning <level>`, персистентный) или активном
   * `set_thinking`-оверрайде агента (транзиентный) — `auto→<level>`. В фикс.
   * режиме — эффективный уровень.
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

  /** Локализованный промпт ввода со встроенным режимом/уровнем reasoning. */
  private inputPrompt(continuation = false): string {
    const key = continuation ? "repl.you_reasoning_cont" : "repl.you_reasoning";
    return pc.cyan(t(key, { level: this.reasoningLabel() }));
  }

  /**
   * Учёт промпта после slash-команды. Команда, прогнавшая прогон (напр. `/run`),
   * уже вернула себе промпт через `runAgent`: повторный показ двоил бы рендер,
   * так что скипаем ровно раз. Все прочие команды показывают промпт здесь.
   */
  private afterCommand(): void {
    if (this.runHandledPrompt) {
      this.runHandledPrompt = false;
      return;
    }
    this.presentPrompt();
  }

  /** Спецклавиши: двойной Esc — аборт прогона, Ctrl+V — вставка картинки, Ctrl+O — детали. */
  private handleSpecialKey(_str: string, key: any): boolean {
    if (key.name === "escape") {
      // Декодер keypress Bun схлопывает быстрый двойной Esc в один keypress, чей
      // `sequence` содержит два ESC-байта ("\x1b\x1b"). Подсчёт байтов (не событий)
      // ловит и схлопнутый случай, и два раздельных Esc в окне.
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

  /** Ctrl+O — допечатка полных деталей последнего действия. */
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
    const accent = toolAccent(last.tool);
    const head = `${accent(glyph.action)} ${accent(last.label)}${
      last.args ? ` ${pc.dim("·")} ${pc.dim(last.args)}` : ""
    }  ${mark} ${pc.dim(`${last.durationMs}ms`)}`;
    const lines = [head, ...last.body.map((l) => `  ${l}`)];
    this.output.writeLine(`\n${lines.join("\n")}`);
    if (this.rl instanceof LineEditor) {
      this.rl.reset();
      this.rl.prompt();
    }
  }

  /** Вставка картинки из буфера обмена (Ctrl+V). */
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
      // Чтение буфера не удалось — игнорим, пусть терминал вставит текст штатно.
    }
  }

  /** Проверка незакрытого многострочного ввода (хвостовой `\` или `{` без `}`). */
  private isMultiLineInput(line: string): boolean {
    if (line.endsWith("\\")) return true;

    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    if (openBraces > closeBraces) return true;

    return false;
  }

  /** Прогон хода агента: стрим в рендерер, футер, бары, возврат промпта. */
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

      // Кадр промпта сейчас снимется; гасим синк до любого стримленного вывода,
      // чтобы ничего не пыталось рисовать поверх него.
      this.promptPresented = false;
      // Отдаём терминал каналу на время прогона: редактор перестаёт рисовать кадр
      // и игнорит клавиши, и стрим не портит строку ввода. suspendFrame() идёт до
      // reset(), который иначе нарисовал бы кадр лишь затем, чтобы стереть.
      if (this.rl instanceof LineEditor) {
        this.rl.suspendFrame();
        this.rl.setInputEnabled(false);
        this.rl.reset();
      }
      this.output.beginStreaming();
      // Разделитель + ярлык агента, сырьём (без trailing newline): следующий чанк
      // Renderer.text() добавляет свой ведущий "\n", и writeLine здесь вставил бы
      // пустую строку ("Agent:\n\n...").
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
            if (ev.tool === "plan" || ev.tool === "todo" || ev.tool === "plan_step") {
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
        (reasoning) => renderer.reasoning(reasoning),
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
      // Закрываем ход агента: разделитель перед следующим промптом визуально
      // разводит соседние сообщения юзера/агента.
      this.output.writeLine(`\n${divider()}`);
    } finally {
      this.agentRunning = false;
      this.output.endStreaming();
      if (this.rl instanceof LineEditor) {
        this.rl.setInputEnabled(true);
        // Единственный показ промпта на пути агента: resumeFrame() перерисовывает
        // кадр, так что слушатель `line` после runAgent() промпт НЕ показывает
        // (после slash-команд — показывает). Промпт переставляем первым, чтобы
        // уровень reasoning, сменённый set_thinking в прогоне, отразился на
        // возобновлённом кадре.
        this.rl.setPrompt(this.inputPrompt());
        this.rl.resumeFrame();
        this.promptPresented = true;
      } else {
        // У пайпнутого/не-TTY фолбэка кадра для resume нет; показываем readline-
        // промпт здесь ради старого пост-прогонного поведения.
        this.presentPrompt();
      }
      const onboardingCtx = this.agent.tryToolContext();
      if (onboardingCtx?.onboarding?.done) {
        exitMeetMode(this);
        this.slog.logOnboarding("meet_done", { model: this.config.model });
        this.output.writeLine(pc.dim(t("repl.meet_done")));
      }
      this.runHandledPrompt = true;
    }
  }

  /** Печать чеклиста плана, трекаемого ExecutionModule.
   *  Зовётся только на plan/todo-событиях (событие изменения), не поллится:
   *  дисковый план прошлой сессии не протечёт в чат. */
  private renderPlan(renderer: Renderer): void {
    const plan = this.execModule?.getActivePlan();
    if (!plan) return;
    renderer.planBlock(formatPlanChecklist(plan));
  }

  private commands: Map<string, SlashCommand> = new Map();

  /** Регистрирует slash-команду (имя + алиасы). */
  public registerCommand(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.set(alias, cmd);
      }
    }
  }

  /** Эксклюзивный ввод: визард владеет терминалом через свои `rl.question()`. */
  public async withExclusiveInput(fn: () => Promise<void>): Promise<void> {
    // Между вопросами активного кадра нет, так что меню/результаты скана пишутся
    // напрямую: обёртка beginModal/endModal сложила бы ВЕСЬ транскрипт в очередь,
    // и юзер видел бы голые `: ` промпты до конца. `inputLocked` гасит
    // `promptSink.isActive()`, пуская записи напрямую.
    this.inputLocked = true;
    try {
      await fn();
    } finally {
      this.inputLocked = false;
    }
  }

  /**
   * Одалживает терминал под один вопрос интерактивного тула и возвращает обратно.
   * На время прогона LineEditor suspended с выключенным вводом; включение ввода +
   * resume кадра даёт `question()` читать клавиши, пока агент блокирован, а `finally`
   * восстанавливает ровно стрим-состояние, и рендерер агента работает дальше как ни в чём.
   *
   * Порядок важен: `beginModal()` сначала сбрасывает вывод, ещё буферный у стрим-канала,
   * чтобы напечатался plain до возврата кадра; `endModal()` идёт лишь после повторного
   * suspend кадра, чтобы события, накопленные за вопрос, сбросились plain, а не побили кадр.
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

  /** Host/HostBridge: true, пока агент крутит ход. */
  public isBusy(): boolean {
    return this.isAgentBusy();
  }

  /** Host/HostBridge: сабмит через общий мост (тот же run-путь). */
  public submit(text: string, opts?: HostBridgeSubmitOptions): Promise<unknown> {
    return this.getHostBridge().submit(text, opts);
  }

  /** Host/HostBridge: прерывание текущего прогона (в idle — no-op). */
  public interrupt(): void {
    this.getHostBridge().interrupt();
  }

  /** Host/HostBridge: подписка на общую шину вывода. */
  public subscribeOutput(fn: (ev: OutputEvent) => void): () => void {
    return defaultOutputBus.subscribe(fn);
  }

  /** Host: прогон slash-команды через ту же handler-map, что и ручной ввод. */
  public async executeCommand(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return;
    await this.dispatchCommand(trimmed);
  }

  /** Host: снапшот план/сессия/модель для UI-поверхностей. */
  public getState(): HostStateSnapshot {
    const meta = this.sessionManager?.getActiveMeta();
    return {
      busy: this.agentRunning,
      sessionId: meta?.id,
      sessionName: meta?.name,
      model: this.config.model,
      provider: this.config.provider?.active,
      plan: planSnapshotFromModule(adaptActivePlan(this.execModule?.getActivePlan())),
    };
  }

  private async dispatchCommand(input: string): Promise<void> {
    const parts = input.split(/\s+/);
    const name = parts[0].slice(1);
    const args = parts.slice(1);

    // Сбрасываем протухший run-флаг прошлого прямого прогона, чтобы решение
    // presentPrompt() этой команды строилось на её собственном действии.
    this.runHandledPrompt = false;

    const cmd = this.commands.get(name);
    if (!cmd) {
      // Бывшие алиасы, уехавшие в субкоманду: указываем на новый синтаксис,
      // а не на голое "unknown command".
      const formerAliases: Record<string, string> = { use: "resume" };
      const suggestion = formerAliases[name];
      if (suggestion) {
        this.output.writeLine(
          pc.red(t("cli.unknown_command", { input: `/${name}`, suggestion: `/${suggestion}` })),
        );
      } else {
        this.output.writeLine(`${pc.red(t("cli.unknown_cmd", { name }))} ${t("cli.help_hint")}`);
      }
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

  /** Показ помощи: общая или по команде (`/help <команда>`). */
  public showHelp(command?: string): void {
    const { COMMAND_GROUPS } = require("./repl-commands") as typeof import("./repl-commands");

    if (command) {
      const name = command.replace(/^\//, "");
      const cmd = this.commands.get(name);
      if (!cmd) {
        this.output.writeLine(pc.red(t("repl.help_unknown", { name })));
        return;
      }
      this.output.writeLine(pc.bold(pc.cyan(`/${cmd.name}`)));
      this.output.writeLine(`  ${cmd.description}`);
      if (cmd.usage) this.output.writeLine(`  ${pc.dim(cmd.usage)}`);
      if (cmd.aliases?.length) {
        this.output.writeLine(pc.dim(`  ${t("repl.help_aliases", { names: cmd.aliases.join(", ") })}`));
      }
      if (cmd.examples?.length) {
        this.output.writeLine(pc.dim(`  ${t("repl.help_examples")}`));
        for (const ex of cmd.examples) this.output.writeLine(pc.dim(`    ${ex}`));
      }
      return;
    }

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
        this.output.writeLine(`  ${pc.cyan(`/${cmd.name}`)}${aliases}  ${pc.dim(cmd.description)}`);
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
          t("repl.api_line", {
            prompt: String(result.promptTokens),
            completion: String(result.completionTokens),
            total: String(result.totalTokens),
          }),
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
        this.output.writeLine(
          pc.dim(`\n  ⟳ ${t("repl.compacted", { count: String(result.compactionCount) })}`),
        );
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
    // Плоские поля протухают после `/provider use` — истина в entries.
    const endpoint = activeProviderEndpoint(this.config.provider);
    row(
      t("repl.provider"),
      `${endpoint.type}  →  ${pc.dim(endpoint.baseUrl)}`,
    );
    row(
      t("repl.context"),
      `${pc.white(String(ctx))}  ${pc.dim(`(${t("repl.ctx_part_system")}:${sysBudget}  ${t("repl.ctx_part_reserve")}:${resBudget}  ${t("repl.ctx_part_history")}:${histBudget})`)}`,
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
        t("repl.skills_available", {
          count: String(this.skillsModule.getAvailable().length),
          budget: String(budget.total),
        }),
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
          t("repl.plugins_active", { count: String(infos.length), names: pluginNames }),
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

    // Показываем workspace агента (каталог `-d`), а не process cwd: `bun run`
    // ставит cwd в корень пакета, где агент НЕ работает.
    row(t("repl.work_dir"), pc.dim(this.baseDir));

    if (this.noAgentsMd) {
      row(t("repl.agents_label"), pc.red(t("repl.disabled")));
    } else {
      const agentsMdCandidates = [
        join(this.baseDir, "AGENTS.md"),
        join(projectMmaDir(this.baseDir), "AGENTS.md"),
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
        `${pc.cyan(meta.name)} ${pc.dim(`(${meta.id.slice(0, 12)})`)}  —  ${meta.messageCount} ${t("repl.msgs")}  ${pc.dim(sessionPath)}`,
      );
    }

    // Статус LSP пробнится фоном — баннер блокировать нельзя.
    const isTty = process.stdout.isTTY === true;
    const lspEnabled = isTty && (this.config.lsp ?? DEFAULT_LSP_CONFIG).enabled !== false;

    // Plain-баннер без рамки: построчно, с переносом по ширине.
    for (const line of info) {
      this.output.writeLine(pc.dim(line).trimEnd());
    }
    this.output.writeLine("");

    // Хинт про legacy-конфиг.
    try {
      const { existsSync: exists } = await import("fs");
      const { join: pathJoin } = await import("path");
      const { hasDomainFiles } = await import("../config/domains");
      const legacyPath = pathJoin(this.configDir, "config.json");
      if (exists(legacyPath) && !hasDomainFiles(this.configDir)) {
        this.output.writeLine(pc.yellow(`  ${t("config.legacy_hint")}`));
        this.output.writeLine("");
      }
    } catch {
      // Хинт best-effort: ошибка чтения его просто скипает.
    }

    // Единственный показ промпта на старте: баннер выше печатался plain
    // (promptPresented был false), так что стирать кадр здесь нечего.
    this.rl.prompt();
    this.promptPresented = true;

    try {
      if (readEnv("START_MEET") === "1" || readEnv("START_INIT") === "1") {
        const mode = readEnv("START_MEET") === "1" ? "meet" : "init";
        delete process.env[MMA_ENV.START_MEET];
        delete process.env[MMA_ENV.START_INIT];
        this.slog.logOnboarding(`${mode}_start`, { model: this.config.model });
        if (mode === "meet") {
          const { runMeet } = await import("../modules/onboarding/meet");
          await runMeet(this);
        } else {
          const { runInit } = await import("../modules/onboarding/init");
          await runInit(this);
          this.slog.logOnboarding("init_done", { model: this.config.model });
        }
      } else if (readEnv("POST_SETUP") === "1" && process.stdout.isTTY === true) {
        const { preflightFromConfig } = await import("../modules/providers/preflight");
        const pre = await preflightFromConfig(this);
        if (pre.ok) {
          this.output.writeLine(pc.dim(`${t("repl.meet_offer")} ${t("repl.meet_offer_hint")}`));
          const answer = (
            await new Promise<string>((resolve) => this.rl.question("[Y/n] ", resolve))
          )
            .trim()
            .toLowerCase();
          const yes =
            answer === "" ||
            answer === "y" ||
            answer === "yes" ||
            answer === "да" ||
            answer === "д";
          if (yes) {
            this.slog.logOnboarding("meet_start", { model: this.config.model });
            const { runMeet } = await import("../modules/onboarding/meet");
            await runMeet(this, { preflight: async () => pre });
          } else {
            this.restoreStartupPrompt();
          }
        } else {
          this.output.writeLine(pc.yellow(t("onboarding.provider_down", { cmd: "meet" })));
          this.output.writeLine(t("onboarding.provider_down_hint", { cmd: "meet" }));
        }
      }
    } catch (err) {
      this.logger?.debug(`Onboarding startup skipped: ${String(err)}`);
      this.restoreStartupPrompt();
    }

    if (lspEnabled) {
      this.probeLspBanner()
        .then((lspSummary) => {
          if (lspSummary) {
            const line = `${pc.green(t("repl.agent"))}${pc.yellow(t("repl.lsp_label"))} ${lspSummary}`;
            // Строкой промпта владеет канал: ручной erase + prompt()-хак не нужен.
            this.output.writeLine(`${divider()}\n${line}`);
          }
        })
        .catch(() => {});
    }

    if ((this.config.provider.entries?.length ?? 0) > 1) {
      // Phase 4.4: фоновый health-пробник всех entries (бесплатные listModels).
      // Упавшие провайдеры — предупреждениями: фейловер (Phase 4.2) молча
      // замаскировал бы мёртвый primary.
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

    // Контекст-пробник (фоном): сверяем контекст, с которым модель реально
    // загружена, против настроенного окна. Тот же неблокирующий баннер-паттерн,
    // что у LSP-пробника выше.
    if (this.contextProbe) {
      void this.contextProbe
        .then((probe) => {
          if (!probe) return;
          // Запись пробника персистит bootstrap (все режимы); здесь только строка баннера.
          const line =
            probe.actual < this.config.contextWindow
              ? `${pc.yellow("⚠")} ${t("repl.context_probe_small", { model: probe.model, actual: probe.actual, configured: this.config.contextWindow })}`
              : probe.actual > this.config.contextWindow
                ? `${pc.dim(t("repl.context_probe_big", { model: probe.model, actual: probe.actual }))}`
                : null;
          if (line) {
            // Строкой промпта владеет канал: ручной erase + prompt()-хак не нужен.
            this.output.writeLine(`${divider()}\n${line}`);
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Пробнит LSP-серверы, применимые к текущему проекту, и форматирует однострочную
   * сводку баннера, напр. "✓ typescript (1.2s)" или "✗ css — timeout".
   * Null, если LSP выключен или серверов нет.
   */
  private async probeLspBanner(): Promise<string | null> {
    const config = this.config.lsp ?? DEFAULT_LSP_CONFIG;
    try {
      const lspOnlyLogger = this.logger ? new FileOnlyLogger(this.logger) : undefined;
      const summary = await probeLspServers(config, this.baseDir, { logger: lspOnlyLogger });
      // Результаты LSP-пробника — в сессию, для пост-мортем видимости.
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

  /** Останов REPL: сейв истории, шатдаун агента, закрытие лога сессии. */
  public stop(): void {
    this.running = false;
    this.saveHistory();
    this.agent.shutdown();
    this.sessionOutput?.dispose();
    this.sessionOutput = undefined;
    // Закрываем лог сессии на останове REPL.
    this.logger?.closeSessionLog();
    this.rl.close();
  }
}
