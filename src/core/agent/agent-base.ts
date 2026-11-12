/**
 * Базовая поверхность агента (`TurnCoordinator`, INV-23): состояние прогона,
 * доступы CLI/REPL, reasoning, промпт и провайдер. Вынесено из `core/agent.ts`;
 * `Agent` добавляет только петлю хода и lifecycle-хуки.
 */
import type { LLMProvider } from "../../llm/provider";
import type { ContextManager } from "../context/manager";
import type { AppConfig, ProviderEntry, ReasoningLevel } from "../../config/types";
import type { PromptBlock } from "../types";
import type { ToolResult } from "../../tools/types";
import type { ReasoningState } from "../../tools/set-thinking";
import type { CostTracker } from "../../modules/pricing/index";
import { CostTracker as CostTrackerCtor } from "../../modules/pricing/index";
import { createPolicyState, type PolicyState } from "../../modules/reasoning/policy";
import { ContextRenderer } from "./context-renderer";
import type { PromptBlockKind, PromptProfile } from "../types";
import type { AgentDeps } from "./deps";
import {
  getProviderFor as phaseGetProviderFor,
  listProviders as phaseListProviders,
  probeIdentityOf,
  reconfigure as phaseReconfigure,
  setProvider as phaseSetProvider,
  type ProbeIdentity,
  type ProviderPhaseHost,
  type ReconfigureOptions,
} from "./provider-phase";
import {
  buildSystemPrompt as phaseBuildSystemPrompt,
  getSystemPromptInfo as phaseGetSystemPromptInfo,
  logContextStat as phaseLogContextStat,
  refreshSystemPrompt as phaseRefreshSystemPrompt,
  resolvePromptOverflowOnce as phaseResolvePromptOverflowOnce,
  type PromptPhaseHost,
  type SystemPromptInfo,
} from "./prompt-phase";
import type { SessionLogger } from "../session-logger";
import { applyClientTz } from "../system-prompt";
import {
  applyReasoningLevel,
  callerProvenance,
  getModule,
  optionalToolContext,
  promptBlocksForTest,
  pushPromptBlock,
  removePromptBlock,
  requireToolContext,
  runToolByName,
} from "./surface";

/**
 * Агент: владеет циклом, конфигом, стоимостью, гейтами. Состояние хода —
 * в LoopState, шаги — в extracted-модулях.
 */
export class AgentBase {
  protected deps: AgentDeps;
  protected costTracker: CostTracker;
  /** Рендер UI-индикаторов контекста (stats-бар/компакция). Экземпляр
   * переживает несколько запусков цикла — хранит lastCompactionShown. */
  protected contextRenderer: ContextRenderer;
  protected policyState: PolicyState;
  /** Итог reasoning-пробы (B2): старт из deps, лениво обновляется в run(). */
  protected probePassed: boolean;
  /** Общее мутабельное reasoning-состояние (владелец — агент, делит с set_thinking). */
  readonly reasoningState: ReasoningState;
  /** Счётчик текущей итерации (для кулдаунов тулов). */
  protected _currentIteration = 0;
  /** Профиль системного промпта (S-04); job-ход ставит `service-job`. */
  promptProfile: PromptProfile = "full";
  /** Kind → блок-замена для instructions/project-map сверх бюджета (резолв раз до первого LLM-вызова). */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: читается через PromptPhaseHost
  private promptOverrides = new Map<PromptBlockKind, PromptBlock>();
  /** Идентичность, против которой гонялась проба. Сравнение ПО ЗНАЧЕНИЮ: все
   *  write-пути мутят живой конфиг in place и передают ТОТ ЖЕ объект в
   *  `reconfigure` — сравнение объектов изменения бы не увидело. Сидируется
   *  в конструкторе (строки до мутаций). */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: читается через ProviderPhaseHost
  private lastProbeIdentity: ProbeIdentity;
  /** Кеш «идентичность → измеренное окно контекста» (INV-W6); пишется фазой. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: читается/пишется через ProviderPhaseHost
  private probeWindowCache = new Map<string, import("../../llm/provider-context").ContextProbeResult>();
  /** Сжатые инструкции; снимок карты проекта на ход (см. PromptPhaseHost). */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: читается/пишется через PromptPhaseHost
  private overflowHintBlock: PromptBlock | null = null;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.costTracker = new CostTrackerCtor(deps.config.model, deps.config.pricing);
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
    applyReasoningLevel(this.reasoningState, level);
  }

  /** Номер текущей итерации (для кулдаунов тулов). */
  get currentIteration(): number {
    return this._currentIteration;
  }

  /** Провенанс вызывающего: живой провайдер и модель (для стоимости/логов). */
  callerProvenance(): { provider: string; model: string } {
    return callerProvenance(this.deps);
  }

  /** Типизированный доступ к модулям для CLI/REPL (напр. /lsp). */
  getModule<T>(name: string): T | undefined {
    return getModule<T>(this.deps.moduleRegistry, name);
  }

  /** Живой итог context-probe для веб-сайдбара: `undefined` — ещё не устоялась. */
  contextProbeSnapshot(): import("../../llm/provider-context").ContextProbeResult | null | undefined {
    return this.deps.contextProbeRef?.current;
  }

  /** Доступен ли активный эндпоинт по последней capabilities-пробе. */
  providerReachableSnapshot(): boolean | undefined {
    return this.deps.capabilitiesProbeRef?.reachable;
  }

  /** Стратегия reasoning, реально применённая к активному провайдеру. */
  providerReasoningSnapshot(): {
    strategy?: import("../../config/types").ReasoningStrategy;
    levels?: string[] | null;
    reasoningOff?: boolean;
    reachable?: boolean;
  } {
    const ref = this.deps.capabilitiesProbeRef;
    return {
      strategy: ref?.reasoningStrategy,
      levels: ref?.reasoningLevels ?? null,
      reasoningOff: ref?.reasoningOff,
      reachable: ref?.reachable,
    };
  }

  /**
   * Запуск тула по имени из CLI/REPL (например, lsp_check). Обходит
   * инкапсуляцию: команды не должны лезть в приватные `deps`.
   */
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return runToolByName(this.deps, name, args);
  }

  protected setScope(): void {
    if (this.deps.scope) {
      this.deps.toolExecutor.setScope(this.deps.scope);
    }
  }

  /**
   * Ставит (или снимает) терминальную prompt-поверхность для интерактивных
   * тулов. Делегирует исполнителю, чтобы общий ToolContext — тот, что реально
   * получают тулы — нёс тот же инстанс.
   */
  setPromptIO(io?: import("../../tools/prompt-io").PromptIO): void {
    this.deps.toolExecutor.setPromptIO(io);
  }

  /**
   * Дописывает системный блок на текущий прогон (гайд онбординга).
   * Удаление по идентичности через `removePromptBlock`. Блоки читаются при
   * каждой `buildSystemPrompt`, эффект — со следующего хода.
   */
  pushPromptBlock(block: PromptBlock): void {
    pushPromptBlock(this.deps, block);
  }

  /** Убирает ранее запушенный блок (по ссылке). */
  removePromptBlock(block: PromptBlock): void {
    removePromptBlock(this.deps, block);
  }

  /** Тестовый вид текущих блоков промпта. */
  getPromptBlocksForTest(): PromptBlock[] {
    return promptBlocksForTest(this.deps);
  }

  /**
   * Ставит часовой пояс клиента (B18b): веб-пул зовёт перед каждым ходом.
   * Пересборка статики — только при смене (иначе рвём prefix-cache впустую).
   * @returns true — статика пересобрана.
   */
  setClientTz(tz: import("../prompt-facts").ClientTz | undefined): boolean {
    return applyClientTz(this.deps, tz);
  }

  /** Общий ToolContext (бросает, если bootstrap его не дал). */
  get toolContext(): import("../../tools/types").ToolContext {
    return requireToolContext(this.deps);
  }

  /** Небросающийся вариант `toolContext` для опциональных/lifecycle-проверок. */
  tryToolContext(): import("../../tools/types").ToolContext | undefined {
    return optionalToolContext(this.deps);
  }

  /** Собирает текущий системный промпт (реализация — `prompt-phase.ts`). */
  protected buildSystemPrompt(): ReturnType<typeof phaseBuildSystemPrompt> {
    return phaseBuildSystemPrompt(this as unknown as PromptPhaseHost);
  }

  /** Текущий системный промпт с подсчётом токенов (для /sysprompt, диагностики). */
  getSystemPromptInfo(): SystemPromptInfo {
    return phaseGetSystemPromptInfo(this as unknown as PromptPhaseHost);
  }

  /** Одноразовый резолв переполнения (реализация — `prompt-phase.ts`). */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: вызывается через TurnRunHost
  private async resolvePromptOverflowOnce(): Promise<void> {
    await phaseResolvePromptOverflowOnce(this as unknown as PromptPhaseHost);
  }

  /**
   * Пишет состояние контекста в лог сессии (реализация — `prompt-phase.ts`).
   */
  protected logContextStat(
    kind: "start" | "iteration",
    iteration: number,
    slog: SessionLogger,
    blocks?: Array<{ label: string; priority: string; tokens: number; included: boolean }>,
  ): void {
    phaseLogContextStat(this as unknown as PromptPhaseHost, kind, iteration, slog, blocks);
  }

  /** Обновляет системное сообщение живого контекста (реализация — `prompt-phase.ts`). */
  protected refreshSystemPrompt(): void {
    phaseRefreshSystemPrompt(this as unknown as PromptPhaseHost);
  }

  /**
   * Применяет новый конфиг живьём (фаза провайдера): context-probe, пересборка
   * провайдера, ресайз бюджетов, стоимость. Реализация — `provider-phase.ts`.
   * @param opts `probe: false` — пропустить context-probe (INV-W6).
   */
  async reconfigure(config: AppConfig, opts?: ReconfigureOptions): Promise<void> {
    await phaseReconfigure(this as unknown as ProviderPhaseHost, config, opts);
  }

  /**
   * Переключает активного провайдера (и модель) тем же путём, что `/config`:
   * re-probe контекста и resize бюджетов. Реализация — `provider-phase.ts`.
   */
  async setProvider(name: string, model?: string): Promise<void> {
    await phaseSetProvider(this as unknown as ProviderPhaseHost, name, model);
  }

  /** Список записей провайдеров с флагом активности. */
  listProviders(): Array<ProviderEntry & { label: string; active: boolean }> {
    return phaseListProviders(this as unknown as ProviderPhaseHost);
  }

  /** Строит провайдер именованной записи (health-чеки, роутинг); null при ошибке. */
  getProviderFor(name: string): LLMProvider | undefined {
    return phaseGetProviderFor(this as unknown as ProviderPhaseHost, name);
  }
}
