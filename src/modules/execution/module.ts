// Execution-модуль: трекер плана, stuck-детектор, аудитор, гейты, автопоиск ошибок.
// Оболочка-композиция (правило 6): план/сессия — `plan-session.ts`, деливераблы
// и тексты плана — `deliverables.ts`, тулы — `plan-tool.ts`, хуки — `execution-plugin.ts`.
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition, ToolContext, ToolCall } from "../../tools/types";
import { StepVerifier } from "./verifier";
import { StuckDetector } from "./stuck-detector";
import { Auditor } from "./auditor";
import type { PlanStore } from "./plan-store";
import type { PlanTracker } from "./tracker";
import type { Plan } from "./planner";
import type { PathSecurityConfig } from "../../config/types";
import { performWebSearch } from "../../tools/web-search";
import { createPlanToolDefinitions } from "./plan-tool";
import { parseKinds, parseChecks } from "./plan-parse";
import { createExecutionPluginState, type ExecutionPluginState } from "./plugin-state";
import { EXECUTION_ERROR_SEARCH_MIN_INTERVAL_MS as ERROR_SEARCH_MIN_INTERVAL_MS } from "../../config/timeouts";
import { runFinalAudit } from "./final-audit";
import { maybeSearchError, type WebSearchRunner } from "./error-search";
import {
  errorSearchHost,
  executionPlugin,
  finalAuditHost,
  type ExecutionHostView,
} from "./module-hosts";
import type { Diagnostic } from "../../output/types";
import { PlanSession, type PendingMessage } from "./plan-session";
import {
  getTaskText,
  hasStepDeliverables,
  missingStepDeliverables,
  noActivePlanMessage,
  stillExistingDeliverables,
} from "./deliverables";

/** Реэкспорт для потребителей (тесты): реализация — в `step-advance.ts`. */
export { provablyStale } from "./step-advance";

/** Реэкспорт для потребителей: реализация типа — в `error-search.ts`. */
export type { WebSearchRunner } from "./error-search";

/** Execution-модуль: план, stuck-детектор, аудитор, гейты выравнивания и автопоиск ошибок. */
export class ExecutionModule implements AgentModule {
  name = "execution";
  /** План, его per-session слот и завершённый план (см. `plan-session.ts`). */
  private plan: PlanSession;
  private verifier: StepVerifier;
  /**
   * Диагностический sink (INV-15, W0.6): пишет `verify_error`, когда проверка
   * шага не выполнена, но признана валидной (нет tsc/tsconfig/тестов). Ставит
   * Agent после создания `SessionLogger`; без агента (юнит-тесты) — no-op.
   */
  private diagnosticSink?: (event: "verify_error", diag: Diagnostic) => void;
  private stuckDetector: StuckDetector;
  private auditor: Auditor;
  private baseDir: string;
  /**
   * Авто-advance шагов по файловым деливераблам (config execution.autoAdvance).
   * При false харнесс только подталкивает модель закрыть шаг самому.
   */
  private autoAdvance = true;
  /**
   * Отложенные <system-summary>. Инжектятся onBeforeTool/onAfterTool, но
   * флашатся в onBeforeThink — никогда не встают между assistant tool_call и
   * его tool-результатами (рвёт спаривание и хоронит варнинги, на которые
   * модель должна реагировать).
   */
  private pendingMessages: PendingMessage[] = [];
  // Per-командные счётчики фейлов запрещённых Windows-команд (grep/sed/ls/
  // find/… через тул bash). Hard stop после второго фейла evidence-based
  // (реальные фейлы команд), не классификация задач (правило #10).
  private forbiddenBashFailures = new Map<string, number>();
  private searchRunner: WebSearchRunner;
  private searchesThisSession = 0;
  private retryWebSearchSignatures = new Set<string>();
  private lastErrorSearchAt = 0;
  /**
   * Минимальный интервал между автопоисками ошибок. Спек просил кап
   * STUCK_RECOVERY_COOLDOWN-итераций, но в onAfterTool нет счётчика итераций
   * (контекст экзекутора) — та же анти-спам защита, но по времени. Инжектится
   * через конструктор для тестов (0 отключает).
   */
  private readonly errorSearchCooldownMs: number;
  private hallucinationDetector: { getConsistencyCheck(): { getDeletedFiles(): string[] } } | null =
    null;

  /**
   * Мутабельное состояние execution-плагина. Владеем ЗДЕСЬ, передаём ПО ССЫЛКЕ
   * фабрике плагина — плагин пишет deps.state.* напрямую, записи видны модулю
   * без write-back.
   */
  private state: ExecutionPluginState = createExecutionPluginState();

  constructor(
    baseDir: string,
    stuckThreshold = 6,
    webSearchThreshold = 5,
    searchRunner: WebSearchRunner = performWebSearch,
    errorSearchCooldownMs = ERROR_SEARCH_MIN_INTERVAL_MS,
    pathSecurity?: PathSecurityConfig,
    logger?: import("../../logger/app-logger").Logger,
  ) {
    this.baseDir = baseDir;
    this.plan = new PlanSession(baseDir, logger);
    this.verifier = new StepVerifier(
      baseDir,
      (operation, reason) => this.reportDegrade(operation, reason),
      pathSecurity,
    );
    this.stuckDetector = new StuckDetector(stuckThreshold, 3, webSearchThreshold);
    this.auditor = new Auditor(baseDir);
    this.searchRunner = searchRunner;
    this.errorSearchCooldownMs = errorSearchCooldownMs;
  }

  /** Подключить диагностический sink (INV-15); зовёт Agent после создания SessionLogger. */
  setDiagnosticSink(sink: (event: "verify_error", diag: Diagnostic) => void): void {
    this.diagnosticSink = sink;
  }

  /** Fail-open верификатора: `verify_error` с причиной (INV-12/15), не «тихий ok». */
  private reportDegrade(operation: string, reason: string): void {
    this.diagnosticSink?.("verify_error", {
      source: "module:execution",
      operation,
      kind: "skipped",
      cause: reason,
      recoverable: true,
    });
  }

  /** Ставит план активным (реализация — `plan-session.ts`). */
  setPlan(plan: Plan): void {
    this.plan.setPlan(plan);
  }

  /** Персистит мутацию существующего плана (реализация — `plan-session.ts`). */
  persistPlan(plan: Plan): void {
    this.plan.persistPlan(plan);
  }

  /** Переключает трекер на план другой сессии (реализация — `plan-session.ts`). */
  switchSession(id: string | null): void {
    this.plan.switchSession(id);
  }

  /** Забывает сессию: чистит её слот плана (реализация — `plan-session.ts`). */
  forgetSession(id: string): void {
    this.plan.forgetSession(id);
  }

  /** Вяжет детектор галлюцинаций: тул plan проверяет удалённость файлов (auto-switch kind gate). */
  setHallucinationDetector(detector: {
    getConsistencyCheck(): { getDeletedFiles(): string[] };
  }): void {
    this.hallucinationDetector = detector;
  }

  /** Запоминает завершённый план для финального аудита (реализация — `plan-session.ts`). */
  recordCompleted(plan: Plan): void {
    this.plan.recordCompleted(plan);
  }

  /** Забывает завершённый план (abort/delete/purge — аудитить нечего). */
  clearCompleted(): void {
    this.plan.clearCompleted();
  }

  /** Включает/выключает авто-advance шагов (config execution.autoAdvance). */
  setAutoAdvance(enabled: boolean): void {
    this.autoAdvance = enabled;
  }

  /** Архивирует завершённый план на границе хода (реализация — `plan-session.ts`). */
  archiveCompletedPlan(): void {
    this.plan.archiveCompletedPlan(this.pendingMessages);
  }

  /** Восстанавливает активный план с диска (реализация — `plan-session.ts`). */
  restorePlan(): boolean {
    return this.plan.restorePlan();
  }

  /** Трекер (null без активного плана). */
  getTracker(): PlanTracker | null {
    return this.plan.getTracker();
  }

  /** Set-able вид трекера, общий с план-тулами (реализация — `plan-session.ts`). */
  get trackerRef(): { current: PlanTracker | null } {
    return this.plan.trackerRef;
  }

  /** Текущий трекаемый план (единый источник правды для UI). */
  getActivePlan(): Plan | null {
    return this.plan.getActivePlan();
  }

  /** Стор планов. */
  getStore(): PlanStore {
    return this.plan.store;
  }

  /** Stuck-детектор. */
  getStuckDetector(): StuckDetector {
    return this.stuckDetector;
  }

  /** Автопоиск в вебе повторяющейся ошибки (реализация — `error-search.ts`). */
  maybeSearchError(ctx: ToolContext, call: ToolCall): void {
    maybeSearchError(errorSearchHost(this.hostView()), ctx, call);
  }

  /** Финальный аудит активного/завершённого плана (реализация — `final-audit.ts`). */
  async runFinalAudit(): Promise<{
    passed: boolean;
    done: number;
    total: number;
    pendingSteps: string[];
    missingFiles: string[];
    summary: string;
  } | null> {
    return runFinalAudit(finalAuditHost(this.hostView()));
  }

  /** Блок системного промпта с чеклистом плана (реализация — `plan-session.ts`). */
  getSystemPromptBlock(): PromptBlock | null {
    return this.plan.getSystemPromptBlock();
  }

  /** Строка "текущий план" для сводки компакции (реализация — `plan-session.ts`). */
  getPlanSummary(): string | null {
    return this.plan.getPlanSummary();
  }

  /** Определения тулов модуля (plan/todo/verify через фабрику plan-tool). */
  getToolDefinitions(): ToolDefinition[] {
    return createPlanToolDefinitions({
      store: this.plan.store,
      verifier: this.verifier,
      trackerRef: this.plan.trackerRef,
      preserveActive: () => this.plan.preserveActive(),
      setPlan: (p) => this.setPlan(p),
      persistPlan: (p) => this.persistPlan(p),
      recordCompleted: (p) => this.recordCompleted(p),
      clearCompleted: () => this.clearCompleted(),
      hasStepDeliverables: (s) => hasStepDeliverables(s),
      missingStepDeliverables: (s) => missingStepDeliverables(this.baseDir, s),
      stillExistingDeliverables: (s) => stillExistingDeliverables(this.baseDir, s),
      parseKinds: (a, st) => parseKinds(a, st),
      parseChecks: (a, st) => parseChecks(a, st),
      getTaskText: (c) => getTaskText(c),
      noActivePlanMessage: () => noActivePlanMessage(this.plan.store),
      typecheckFailures: this.state.typecheckFailures,
      baseDir: this.baseDir,
      wasFileDeleted: this.hallucinationDetector
        ? (path: string) =>
            this.hallucinationDetector!.getConsistencyCheck().getDeletedFiles().includes(path)
        : undefined,
    });
  }

  /** Плагин модуля (хуки цикла из фабрики execution-plugin). */
  getPlugin(): AgentPlugin {
    return executionPlugin(() => this.hostView(), this.forbiddenBashFailures);
  }

  /** Снимок состояния модуля для хостов хуков (INV-23, см. `module-hosts.ts`). */
  private hostView(): ExecutionHostView {
    return {
      baseDir: this.baseDir,
      plan: this.plan,
      auditor: this.auditor,
      state: this.state,
      pendingMessages: this.pendingMessages,
      autoAdvance: this.autoAdvance,
      stuckDetector: this.stuckDetector,
      searchRunner: this.searchRunner,
      errorSearchCooldownMs: this.errorSearchCooldownMs,
      searchesThisSession: this.searchesThisSession,
      lastErrorSearchAt: this.lastErrorSearchAt,
      retryWebSearchSignatures: this.retryWebSearchSignatures,
      setSearchesThisSession: (n) => {
        this.searchesThisSession = n;
      },
      setLastErrorSearchAt: (n) => {
        this.lastErrorSearchAt = n;
      },
    };
  }
}
