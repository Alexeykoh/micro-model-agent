/** Агент: одиночный цикл хода (INIT→…→OUTPUT), бюджеты, гейты. */
import type { LLMProvider, ContentPart } from "../llm/provider";
import type { ToolExecutor } from "../tools/executor";
import {
  getProviderFor as phaseGetProviderFor,
  listProviders as phaseListProviders,
  probeIdentityOf,
  reconfigure as phaseReconfigure,
  setProvider as phaseSetProvider,
  type ProbeIdentity,
  type ProviderPhaseHost,
} from "./agent/provider-phase";
import {
  buildSystemPrompt as phaseBuildSystemPrompt,
  getSystemPromptInfo as phaseGetSystemPromptInfo,
  logContextStat as phaseLogContextStat,
  refreshSystemPrompt as phaseRefreshSystemPrompt,
  resolvePromptOverflowOnce as phaseResolvePromptOverflowOnce,
  type PromptPhaseHost,
} from "./agent/prompt-phase";
import {
  emitPhase as phaseEmitPhase,
  finalizeWithoutTools as phaseFinalizeWithoutTools,
  type TurnOutputHost,
} from "./agent/turn-output";
import type { LoopSetupHost } from "./agent/loop-setup";
import type { LoopResultHost } from "./agent/loop-result";
import type { IterationPrologueHost } from "./agent/iteration-prologue";
import type { LlmPhaseHost } from "./agent/loop-llm";
import type { BatchHost } from "./agent/loop-batch";
import { runTurn, type TurnRunHost } from "./agent/turn-run";
import { executeAgentLoop } from "./agent/loop-run";
import type { PluginManager } from "../modules/plugins/manager";
import type { ContextManager, Message } from "../core/context/manager";
import type { HallucinationDetector } from "../core/hallucination/detector";
import type { Logger } from "../logger/app-logger";
import type { AppConfig, ProviderEntry } from "../config/types";
import type { ToolScope, ToolResult } from "../tools/types";
import type { PromptBlock } from "./types";
import type { EnvironmentReport } from "./environment";
import type { ToolEvent, AgentPhase, AgentResult, OnMeta } from "./types";
import type { SessionManager } from "../modules/session/manager";
import type { ModuleRegistry } from "../modules/registry";
import { t } from "../i18n/index";
import { processRegistry } from "../modules/processes";
import { SessionLogger } from "./session-logger";
import type { MemoryStore } from "../modules/memory/store";
import { CostTracker } from "../modules/pricing/index";
import { createPolicyState } from "../modules/reasoning/policy";
import type { PolicyState } from "../modules/reasoning/policy";
import type { ReasoningLevel } from "../config/types";
import type { ReasoningState } from "../tools/set-thinking";
import type { LoopState } from "./agent/loop-state";
import type { TokenTracker } from "./agent/token-tracker";
import type { ContextLogger } from "./agent/context-log";
import { ContextRenderer } from "./agent/context-renderer";
import type { PromptBlockKind } from "./types";

export { toolOutputCharLimit, compactToolError } from "./agent/tool-output";

/** Зависимости агента: конфиг, провайдер, тулы, контекст, логгеры, швы. */
export interface AgentDeps {
  config: AppConfig;
  /**
   * Общий живой бокс конфига. `reconfigure` меняет и `config`, и
   * `configRef.current`, чтобы захваченные при bootstrap ссылки (toolCtx.config,
   * валидаторы) видели текущие настройки.
   */
  configRef?: { current: AppConfig };
  llmProvider: LLMProvider;
  toolExecutor: ToolExecutor;
  pluginManager: PluginManager;
  contextManager: ContextManager;
  hallucinationDetector: HallucinationDetector;
  logger: Logger;
  baseDir: string;
  scope?: ToolScope;
  toolTags?: string[];
  promptBlocks: PromptBlock[];
  getDynamicPromptBlocks?: () => PromptBlock[];
  /**
   * Блоки промпта, вычисляемые асинхронно (напр., стартовый LSP/tsc health-check).
   * Промис стартует при bootstrap и баннер не блокирует; `run()` ждёт его
   * перед первым системным промптом, чтобы модель получила baseline до первого
   * LLM-вызова. Ждёт только первый `run()`.
   */
  lazyPromptBlocks?: () => Promise<PromptBlock[]>;
  finalAudit?: () => Promise<{
    passed: boolean;
    done: number;
    total: number;
    pendingSteps: string[];
    missingFiles: string[];
    summary: string;
  } | null>;
  sessionManager?: SessionManager;
  /** Общий ToolContext (состояние скоупа: allowlist, онбординг). */
  toolCtx?: import("../tools/types").ToolContext;
  /** Opt-in git-style логгер контекста (--context-log). Null/undefined — выкл. */
  contextLogger?: ContextLogger;
  memoryStore?: MemoryStore;
  moduleRegistry?: ModuleRegistry;
  /** Владелец жизненного цикла модулей: `dispose()` (teardown) на завершении. */
  moduleHost?: import("./module-host").ModuleHost;
  exitOnComplete?: boolean;
  envReport?: EnvironmentReport;
  /**
   * Прошёл ли механизм reasoning-effort валидацию пробой. Только стартовое
   * значение — живой итог даёт `reasoningProbe` (B2), который агент лениво
   * ждёт перед первым LLM-вызовом.
   */
  reasoningProbePassed?: boolean;
  /**
   * Резолвит фоновую reasoning-пробу. Потребляется лениво рядом с
   * `lazyPromptBlocks`, чтобы bootstrap не блокировался на round-trip пробы;
   * до резолва механизм считается НЕ прошедшим.
   */
  reasoningProbe?: () => Promise<boolean>;
  /** Стратегия выражения reasoning effort на этом провайдере. */
  reasoningStrategy?: import("../config/types").ReasoningStrategy;
  /** Каталог конфига — для хинта «подними окно контекста» в варнингах. */
  configDir?: string;
  /**
   * Компактная статус-строка плана для <system-summary>. Заменяет динамический
   * план-блок в системном промпте, чтобы промпт оставался иммутабельным
   * (дружелюбен KV-кешу). Null, если активного плана нет.
   */
  planSummary?: () => string | null;
  /** Тестовый шов — подменяет настоящий verify критика (моки Bun глобальны). */
  criticOverride?: {
    verify: (pack: import("../modules/critic/types").EvidencePack, signal?: AbortSignal) => Promise<import("../modules/critic/types").CriticVerdict | null>;
  };
  /**
   * Живое имя активной записи провайдера. Нужно, т.к. прозрачный failover
   * (FallbackProvider) переключает активную запись менеджера без обновления
   * `config.provider.active`; провенанс/стоимость должны отражать реально
   * обслужившего провайдера.
   */
  getProviderName?: () => string;
}

// `mutationTargetKey` переехал в `agent/loop-nudges.ts`; реэкспорт — для совместимости.
export { mutationTargetKey } from "./agent/loop-nudges";

/**
 * Агент: владеет циклом, конфигом, стоимостью, гейтами. Состояние хода —
 * в LoopState, шаги — в extracted-модулях.
 */
export class Agent {
  private deps: AgentDeps;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: пишется через TurnRunHost
  private systemPromptAdded = false;
  private shutdownRequested = false;
  private abortController: AbortController | null = null;
  private costTracker: CostTracker;
  /** Рендер UI-индикаторов контекста (stats-бар/компакция). Экземпляр
   * переживает несколько запусков цикла — хранит lastCompactionShown. */
  private contextRenderer: ContextRenderer;
  private policyState: PolicyState;
  /** Итог reasoning-пробы (B2): старт из deps, лениво обновляется в run(). */
  private probePassed: boolean;
  /** Общее мутабельное reasoning-состояние (владелец — агент, делит с set_thinking). */
  readonly reasoningState: ReasoningState;
  /** Счётчик текущей итерации (для кулдаунов тулов). */
  private _currentIteration = 0;
  /** Kind → блок-замена для instructions/project-map сверх бюджета (резолв раз до первого LLM-вызова). */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: читается через PromptPhaseHost
  private promptOverrides = new Map<PromptBlockKind, PromptBlock>();
  /** Идентичность, против которой гонялась проба. Сравнение ПО ЗНАЧЕНИЮ: все
   *  write-пути мутят живой конфиг in place и передают ТОТ ЖЕ объект в
   *  `reconfigure` — сравнение объектов изменения бы не увидело. Сидируется
   *  в конструкторе (строки до мутаций). */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: читается через ProviderPhaseHost
  private lastProbeIdentity: ProbeIdentity;
  /** Малый всегда-включённый блок про сжатые инструкции. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: читается/пишется через PromptPhaseHost
  private overflowHintBlock: PromptBlock | null = null;
  /** Гард одноразового асинхронного резолва переполнения в run(). */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: пишется через TurnRunHost
  private overflowResolved = false;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.costTracker = new CostTracker(deps.config.model, deps.config.pricing);
    this.contextRenderer = new ContextRenderer();
    this.policyState = createPolicyState();
    this.probePassed = deps.reasoningProbePassed ?? false;
    this.lastProbeIdentity = probeIdentityOf(deps.config);
    const initialLevel = (deps.config.reasoning?.mode !== "auto" ? deps.config.reasoning?.mode : undefined) ?? "medium";
    this.reasoningState = { level: initialLevel, overrideIteration: -100 };
  }

  /** Менеджер контекста наружу (аттач картинок в REPL и др. прямой доступ). */
  get contextManager(): ContextManager {
    return this.deps.contextManager;
  }

  /** Текущий эффективный уровень reasoning. */
  get reasoningLevel(): ReasoningLevel {
    return this.reasoningState.level;
  }

  /** Ставит уровень reasoning (REPL/CLI). "auto" снимает ручной override. */
  setReasoningLevel(level: ReasoningLevel | "auto"): void {
    if (level === "auto") {
      this.reasoningState.manual = false;
      return;
    }
    this.reasoningState.level = level;
    this.reasoningState.manual = true;
  }

  /** Номер текущей итерации (для кулдаунов тулов). */
  get currentIteration(): number {
    return this._currentIteration;
  }

  /**
   * Провенанс вызывающего: живой провайдер и модель (для стоимости/логов).
   * @returns {provider, model} реально обслужившие вызов.
   */
  callerProvenance(): { provider: string; model: string } {
    // Сначала живое имя: sticky failover переключает активную запись
    // менеджера, не трогая config.provider.active.
    const live = this.deps.getProviderName?.();
    if (live) return { provider: live, model: this.deps.config.model };

    const p = this.deps.config.provider;
    let providerName = p?.type || "unknown";
    // При записях провайдера — метка активной, чтобы провенанс стоимости
    // различался (напр. "lmstudio" vs "ollama").
    if (p?.entries && p.entries.length > 0) {
      const entry = p.active
        ? p.entries.find((e) => e.label === p.active || e.type === p.active)
        : p.entries[0];
      if (entry) providerName = entry.label || entry.type || providerName;
    }
    return { provider: providerName, model: this.deps.config.model };
  }

  /** Типизированный доступ к модулям для CLI/REPL (напр. /lsp). */
  getModule<T>(name: string): T | undefined {
    return this.deps.moduleRegistry?.get(name) as T | undefined;
  }

  /**
   * Запуск тула по имени из CLI/REPL (например, lsp_check). Обходит
   * инкапсуляцию: команды не должны лезть в приватные `deps`.
   */
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.deps.toolExecutor.executeByName(name, args);
  }

  private setScope(): void {
    if (this.deps.scope) {
      this.deps.toolExecutor.setScope(this.deps.scope);
    }
  }

  /**
   * Ставит (или снимает) терминальную prompt-поверхность для интерактивных
   * тулов. Делегирует исполнителю, чтобы общий ToolContext — тот, что реально
   * получают тулы — нёс тот же инстанс.
   */
  setPromptIO(io?: import("../tools/prompt-io").PromptIO): void {
    this.deps.toolExecutor.setPromptIO(io);
  }

  /**
   * Дописывает системный блок на текущий прогон (гайд онбординга).
   * Удаление по идентичности через `removePromptBlock`. Блоки читаются при
   * каждой `buildSystemPrompt`, эффект — со следующего хода.
   */
  pushPromptBlock(block: PromptBlock): void {
    this.deps.promptBlocks.push(block);
  }

  /** Убирает ранее запушенный блок (по ссылке). */
  removePromptBlock(block: PromptBlock): void {
    const i = this.deps.promptBlocks.indexOf(block);
    if (i >= 0) this.deps.promptBlocks.splice(i, 1);
  }

  /** Тестовый вид текущих блоков промпта. */
  getPromptBlocksForTest(): PromptBlock[] {
    return this.deps.promptBlocks;
  }

  /** Общий ToolContext (бросает, если bootstrap его не дал). */
  get toolContext(): import("../tools/types").ToolContext {
    if (!this.deps.toolCtx) throw new Error("toolCtx not provided to Agent");
    return this.deps.toolCtx;
  }

  /** Небросающийся вариант `toolContext` для опциональных/lifecycle-проверок. */
  tryToolContext(): import("../tools/types").ToolContext | undefined {
    return this.deps.toolCtx;
  }

  private buildSystemPrompt(): ReturnType<typeof phaseBuildSystemPrompt> {
    return phaseBuildSystemPrompt(this as unknown as PromptPhaseHost);
  }

  /**
   * Пишет состояние контекста в лог сессии (реализация — `agent/prompt-phase.ts`).
   */
  private logContextStat(
    kind: "start" | "iteration",
    iteration: number,
    slog: SessionLogger,
    blocks?: Array<{ label: string; priority: string; tokens: number; included: boolean }>,
  ): void {
    phaseLogContextStat(this as unknown as PromptPhaseHost, kind, iteration, slog, blocks);
  }

  /** Текущий системный промпт с подсчётом токенов (для /sysprompt, диагностики). */
  getSystemPromptInfo(): { text: string; tokenCount: number; excluded: string[] } {
    return phaseGetSystemPromptInfo(this as unknown as PromptPhaseHost);
  }

  /** Одноразовый резолв переполнения (реализация — `agent/prompt-phase.ts`). */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: вызывается через TurnRunHost
  private async resolvePromptOverflowOnce(): Promise<void> {
    await phaseResolvePromptOverflowOnce(this as unknown as PromptPhaseHost);
  }

  private refreshSystemPrompt(): void {
    phaseRefreshSystemPrompt(this as unknown as PromptPhaseHost);
  }

  /** Общий вид хоста для фазы вывода (INV-23). */
  private turnOutputHost(): TurnOutputHost {
    return {
      deps: this.deps,
      abortSignal: this.abortController?.signal,
      isShutdownRequested: () => this.shutdownRequested,
    };
  }

  /** Общий вид хоста для настройки модулей петли (INV-23). */
  private loopSetupHost(): LoopSetupHost {
    return {
      deps: this.deps,
      costTracker: this.costTracker,
      getAbortSignal: () => this.abortController?.signal,
      isShutdownRequested: () => this.shutdownRequested,
      setScope: () => this.setScope(),
      callerProvenance: () => this.callerProvenance(),
    };
  }

  /** Общий вид хоста для сборки результата петли (INV-23). */
  private loopResultHost(): LoopResultHost {
    return {
      deps: this.deps,
      costTracker: this.costTracker,
      isShutdownRequested: () => this.shutdownRequested,
    };
  }

  /** Общий вид хоста для пролога итерации (INV-23). */
  private iterationPrologueHost(): IterationPrologueHost {
    return {
      deps: this.deps,
      buildSystemPrompt: () => this.buildSystemPrompt(),
      logContextStat: (kind, iteration, slog, blocks) =>
        this.logContextStat(kind, iteration, slog, blocks),
      refreshSystemPrompt: () => this.refreshSystemPrompt(),
    };
  }

  /** Общий вид хоста для фазы вызова LLM (INV-23). */
  private llmPhaseHost(): LlmPhaseHost {
    return {
      deps: this.deps,
      policyState: this.policyState,
      probePassed: this.probePassed,
      reasoningState: this.reasoningState,
      isShutdownRequested: () => this.shutdownRequested,
      getAbortSignal: () => this.abortController?.signal,
      emitPhase: (iteration, phase, onPhase) => this.emitPhase(iteration, phase, onPhase),
    };
  }

  /** Общий вид хоста для фазы исполнения батча тулов (INV-23). */
  private batchHost(): BatchHost {
    return {
      deps: this.deps,
      renderContext: (onMeta) =>
        this.contextRenderer.render(this.deps.config.ui, this.deps.contextManager, onMeta),
    };
  }

  private emitPhase(
    iteration: number,
    phase: AgentPhase,
    onPhase?: (phase: AgentPhase) => void,
  ): void {
    phaseEmitPhase(this.turnOutputHost(), iteration, phase, onPhase);
  }

  /**
   * Аварийное завершение без тулов (реализация — `agent/turn-output.ts`):
   * один вызов модели без инструментов; гейты пропускаются.
   */
  private async finalizeWithoutTools(
    state: LoopState,
    tokenTracker: TokenTracker,
    onChunk?: (chunk: string) => void,
    slog?: SessionLogger,
  ): Promise<string> {
    return phaseFinalizeWithoutTools(this.turnOutputHost(), state, tokenTracker, onChunk, slog);
  }

  /**
   * Прогоняет ход агента (одиночный цикл) с автонеймингом сессии.
   * @param input сообщение пользователя; @param onChunk/onMeta/onTool/onPhase/onReasoning колбэки вывода;
   * @returns итог прогона.
   */
  async run(
    input: string,
    onChunk?: (chunk: string) => void,
    onMeta?: OnMeta,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
    onReasoning?: (reasoning: string) => void,
  ): Promise<AgentResult> {
    return runTurn(
      this as unknown as TurnRunHost,
      input,
      onChunk,
      onMeta,
      onTool,
      onPhase,
      onReasoning,
    );
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: вызывается через TurnRunHost
  private async executeSingleAgentLoop(
    input: string,
    slog: SessionLogger,
    onChunk?: (chunk: string) => void,
    onMeta?: OnMeta,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
    onReasoning?: (reasoning: string) => void,
  ): Promise<AgentResult> {
    this.abortController = new AbortController();
    return executeAgentLoop(
      {
        deps: this.deps,
        setIteration: (n) => {
          this._currentIteration = n;
        },
        isShutdownRequested: () => this.shutdownRequested,
        loopSetupHost: () => this.loopSetupHost(),
        iterationPrologueHost: () => this.iterationPrologueHost(),
        llmPhaseHost: () => this.llmPhaseHost(),
        batchHost: () => this.batchHost(),
        loopResultHost: () => this.loopResultHost(),
        finalizeWithoutTools: (state, tt, onChunk, slog) =>
          this.finalizeWithoutTools(state, tt, onChunk, slog),
      },
      input,
      slog,
      onChunk,
      onMeta,
      onTool,
      onPhase,
      onReasoning,
    );
  }

  /** Сбрасывает контекст (следующий прогон пересоберёт системный промпт). */
  clearContext(): void {
    this.deps.contextManager.clear();
    this.systemPromptAdded = false;
  }

  /**
   * Применяет новый конфиг живьём (фаза провайдера): context-probe, пересборка
   * провайдера, ресайз бюджетов, стоимость. Реализация — `agent/provider-phase.ts`.
   */
  async reconfigure(config: AppConfig): Promise<void> {
    await phaseReconfigure(this as unknown as ProviderPhaseHost, config);
  }

  /**
   * Переключает активного провайдера (и модель) тем же путём, что `/config`:
   * re-probe контекста и resize бюджетов. Реализация — `agent/provider-phase.ts`.
   */
  async setProvider(name: string, model?: string): Promise<void> {
    await phaseSetProvider(this as unknown as ProviderPhaseHost, name, model);
  }

  /** Список записей провайдеров с флагом активности. */
  listProviders(): Array<ProviderEntry & { label: string; active: boolean }> {
    return phaseListProviders(this as unknown as ProviderPhaseHost);
  }

  /** Строит провайдер именованной записи (health-чеки, роутинг); null при ошибке. */
  getProviderFor(name: string): import("../llm/provider").LLMProvider | undefined {
    return phaseGetProviderFor(this as unknown as ProviderPhaseHost, name);
  }

  /**
   * Заменяет контекст историей (resume): системный промпт + сообщения без дубля system.
   * @param messages сообщения для восстановления.
   */
  setContext(
    messages: Array<{
      role: string;
      content: string | ContentPart[];
      name?: string;
    }>,
  ): void {
    const { contextManager } = this.deps;
    contextManager.clear();
    const { prompt: systemPrompt } = this.buildSystemPrompt();
    contextManager.addMessage({ role: "system", content: systemPrompt });
    this.systemPromptAdded = true;
    for (const msg of messages) {
      if (msg.role === "system") continue;
      contextManager.addMessage({
        role: msg.role as Message["role"],
        content: msg.content,
        name: msg.name,
      });
    }
  }

  /**
   * Останавливает прогон: abort, kill фоновых процессов, onSessionEnd.
   * Лог сессии НЕ закрываем — сессия ещё активна (закрытие только на
   * реальном конце: exit, удаление сессии).
   * @param sessionId когда задан — убиваются только процессы этой сессии
   * (параллельные раннеры не трогают чужие фоновые процессы; без него —
   * все, как раньше).
   */
  shutdown(sessionId?: string): void {
    this.shutdownRequested = true;
    this.abortController?.abort();
    const { pluginManager, logger, sessionManager, contextManager } = this.deps;
    contextManager.onCompact = null;
    const killed = processRegistry.killAll(sessionId);
    if (killed > 0) {
      logger.info(t("env.killed_processes", { count: String(killed) }));
    }
    // Сессионный лог тут НЕ закрываем — сессия ещё активна.
    // Закрытие только на реальном конце (exit, удаление сессии).
    pluginManager.runOnSessionEnd({
      logger,
      sessionManager: sessionManager?.getActiveMeta(),
      contextManager,
    });
    // Жизненный цикл модулей: teardown (закрыть процессы/сокеты). Fire-and-forget
    // — как и `onSessionEnd`; идемпотентность teardown у модулей на совести модуля.
    void this.deps.moduleHost?.dispose();
  }
}
