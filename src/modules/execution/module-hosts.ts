// Хосты execution-модуля (INV-23): узкие снимки состояния модуля для гейтов
// шага/аудита/выравнивания и автопоиска ошибок. Вынесено из `module.ts`
// (правило 6); поведение и порядок вызовов не менялись.
import type { ExecutionPluginState } from "./plugin-state";
import type { Auditor } from "./auditor";
import type { StuckDetector } from "./stuck-detector";
import { advancePlanIfStepComplete, type StepAdvanceDeps } from "./step-advance";
import type { FinalAuditHost } from "./final-audit";
import { checkPlanAlignment, type PlanAlignmentHost } from "./plan-alignment";
import { maybeSearchError, type ErrorSearchHost } from "./error-search";
import { createExecutionPlugin } from "./execution-plugin";
import type { PlanSession, PendingMessage } from "./plan-session";
import type { AgentPlugin } from "../types";

/** Снимок состояния `ExecutionModule` на момент вызова хука (живёт один вызов). */
export interface ExecutionHostView {
  baseDir: string;
  plan: PlanSession;
  auditor: Auditor;
  state: ExecutionPluginState;
  pendingMessages: PendingMessage[];
  autoAdvance: boolean;
  stuckDetector: StuckDetector;
  searchRunner: ErrorSearchHost["searchRunner"];
  errorSearchCooldownMs: number;
  searchesThisSession: number;
  lastErrorSearchAt: number;
  retryWebSearchSignatures: Set<string>;
  setSearchesThisSession(n: number): void;
  setLastErrorSearchAt(n: number): void;
}

/** Хост шаг-гейта: текущее состояние модуля для `step-advance.ts`. */
export function stepAdvanceDeps(view: ExecutionHostView): StepAdvanceDeps {
  return {
    baseDir: view.baseDir,
    tracker: view.plan.getTracker(),
    store: view.plan.store,
    depsGateHints: view.state.depsGateHints,
    pendingMessages: view.pendingMessages,
    autoAdvance: view.autoAdvance,
    typecheckFailures: view.state.typecheckFailures,
    flushSessionPlan: () => view.plan.flushSessionPlan(),
    setPendingAutoArchive: () => view.plan.setPendingAutoArchive(),
  };
}

/** Хост финального аудита для `final-audit.ts`. */
export function finalAuditHost(view: ExecutionHostView): FinalAuditHost {
  return {
    baseDir: view.baseDir,
    tracker: view.plan.getTracker(),
    completedPlan: view.plan.getCompletedPlan(),
    typecheckFailures: view.state.typecheckFailures,
    auditor: view.auditor,
    store: view.plan.store,
    auditSkipsRemaining: view.plan.getAuditSkipsRemaining(),
    mutatedThisTurn: view.state.mutatedThisTurn,
    setAuditSkipsRemaining: (n) => view.plan.setAuditSkipsRemaining(n),
    flushSessionPlan: () => view.plan.flushSessionPlan(),
  };
}

/** Хост гейта выравнивания для `plan-alignment.ts`. */
export function planAlignmentHost(view: ExecutionHostView): PlanAlignmentHost {
  return { tracker: view.plan.getTracker() };
}

/** Хост автопоиска ошибок для `error-search.ts`. */
export function errorSearchHost(view: ExecutionHostView): ErrorSearchHost {
  return {
    stuckDetector: view.stuckDetector,
    tracker: view.plan.getTracker(),
    pendingMessages: view.pendingMessages,
    retrySignatures: view.retryWebSearchSignatures,
    searchRunner: view.searchRunner,
    errorSearchCooldownMs: view.errorSearchCooldownMs,
    searchesThisSession: view.searchesThisSession,
    lastErrorSearchAt: view.lastErrorSearchAt,
    setSearchesThisSession: view.setSearchesThisSession,
    setLastErrorSearchAt: view.setLastErrorSearchAt,
  };
}

/**
 * Плагин цикла модуля. Хосты собираются на каждый вызов (`view()`), поэтому
 * трекер и авто-advance остаются живыми, как и при прямых замыканиях модуля.
 */
export function executionPlugin(
  view: () => ExecutionHostView,
  forbiddenBashFailures: Map<string, number>,
): AgentPlugin {
  const base = view();
  return createExecutionPlugin({
    stuckDetector: base.stuckDetector,
    trackerRef: base.plan.trackerRef,
    pendingMessages: base.pendingMessages,
    forbiddenBashFailures,
    state: base.state,
    store: base.plan.store,
    checkPlanAlignment: (call) => checkPlanAlignment(planAlignmentHost(view()), call),
    advancePlanIfStepComplete: (sl) => advancePlanIfStepComplete(stepAdvanceDeps(view()), sl),
    archiveCompletedPlan: () => view().plan.archiveCompletedPlan(base.pendingMessages),
    maybeSearchError: (ctx, call) => maybeSearchError(errorSearchHost(view()), ctx, call),
  });
}
