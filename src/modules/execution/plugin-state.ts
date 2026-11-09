// Состояние и константы execution-плагина (вынесено из `execution-plugin.ts`,
// правило 6). Модуль владеет объектом состояния и передаёт его по ссылке.
import type { StuckDetector } from "./stuck-detector";
import type { PlanTracker } from "./tracker";
import type { PlanStore } from "./plan-store";
import type { ToolCall, ToolContext } from "../../tools/types";

/**
 * Структурный контекст `onBeforeThink` execution-плагина. Поля — только те,
 * которые хук реально читает (по builtThinkCtx в agent.ts); остальное —
 * неизвестный пакет плагинного диспетчера (см. debt: контракт плагинов).
 */
export interface ExecutionThinkContext {
  turnSeq?: unknown;
  iteration?: unknown;
  contextManager?: { addMessage(message: { role: "user"; content: string }): void };
  logger?: {
    warn(message: string): void;
    diagnostic?(level: string, message: string): void;
  };
  sessionLog?: {
    directive(event: string, detail: string, iteration?: number): void;
  };
  onMeta?: (text: string) => void;
}

/** Контекст `onToolCall` execution-плагина (toolName + args из диспетчера). */
export interface ExecutionToolContext {
  toolName?: unknown;
  args?: unknown;
}

/**
 * Кулдаун (в итерациях) между инжектами stuck-восстановления. Экспортируется,
 * чтобы ExecutionModule сидировал state.lastRecoveryIteration тем же офсетом,
 * с которым плагин сравнивает.
 */
export const STUCK_RECOVERY_COOLDOWN = 5;
export const MAX_PLAN_WARNINGS_BEFORE_BLOCK = 3;
export const FORCE_SKIP_THRESHOLD = 10;
/** Один и тот же stuck-варнинг перелоггируем не чаще каждых N итераций (новый
 *  ключ — всегда сразу). Не даёт идентичному варнингу флудить каждую итерацию
 *  (было в ses_mt4fn58c: "Tool bash failed N times" после ~30 успешных записей). */
export const STUCK_WARN_REPEAT_EVERY = 5;
/** Сколько файл-мутирующих вызовов (write/edit/bash/download) без активного
 *  плана триггерит nudge создания плана. Evidence-based (правило #10):
 *  агент явно работает с файлами — план оправдан. */
export const PLAN_NUDGE_THRESHOLD = 2;

/** Тулы, чей успех мог поменять ФС — после них перепроверяем deliverables
 *  текущего шага для автопродвижения. Read-only осознанно исключены (см. вызов
 *  advance в onAfterTool ниже). */
export const FS_MUTATING_TOOLS = new Set([
  "write_file",
  "append_file",
  "edit_file",
  "delete_file",
  "move_file",
  "create_dir",
  "bash",
  "download_file",
  "subagent",
  "mcp_call",
  "pipeline_run",
  "browser",
]);

/**
 * Мутабельное состояние, в которое пишет плагин. Модуль ВЛАДЕЕТ объектом и
 * передаёт по ссылке — каждая запись здесь видна модулю.
 */
export interface ExecutionPluginState {
  lastRecoveryIteration: number;
  /**
   * Ход, в котором последний раз сбрасывалось per-step состояние детектора.
   * Сброс — раз в ход: без плана детектор обязан копить улики фейлов, а не
   * обнуляться каждую итерацию (§1.2 аудита).
   */
  lastTurnResetIteration: number;
  /** Ход последнего recovery-инжекта: кулдаун не должен пересекать ходы (§1.11). */
  lastRecoveryTurn: number;
  /** Ход последнего stuck-варнинга (варнинг не должен «замолчать» на ход). */
  lastStuckWarnTurn: number;
  consecutivePlanWarnings: number;
  lastStepId: number;
  stuckNotified: boolean;
  /** Стабильный ключ последнего залогированного stuck-варнинга (getWarningKey) + итерация. */
  lastStuckWarnKey: string;
  lastStuckWarnIter: number;
  /** Model-facing директива эскалации уже инжектилась в текущем stuck-эпизоде
   *  (не повторяем каждый кулдаун). */
  escalationDirectiveSent: boolean;
  depsGateHints: Map<number, number>;
  /** Вызовы write/edit/bash/download БЕЗ активного плана. */
  mutationsWithoutPlan: number;
  /** Nudge создания плана уже инжектился. */
  planNudgeSent: boolean;
  /**
   * Файлы, которые последний write/edit пометил как роняющие проектный
   * typecheck или синтаксис-чек, → первая строка ошибки. Чистится чистым
   * результатом write/edit (дебаунснутый проектный tsc перегнал и прошёл).
   * Done-gate плана реджектит "done", пока файлы шага здесь.
   */
  typecheckFailures: Map<string, string>;
  /** За текущий ход был успешный вызов, способный изменить файлы дерева. */
  mutatedThisTurn: boolean;
}

/** Зависимости плагина: детектор, трекер, стор, гейты (владеет всем модуль). */
export interface ExecutionPluginDeps {
  stuckDetector: StuckDetector;
  trackerRef: { readonly current: PlanTracker | null };
  pendingMessages: Array<{ role: "user"; content: string }>;
  forbiddenBashFailures: Map<string, number>;
  state: ExecutionPluginState;
  store: PlanStore;
  checkPlanAlignment(call: ToolCall): string | null;
  advancePlanIfStepComplete(sessionLog?: {
    plan(event: string, detail: string, iteration?: number): void;
  }): void;
  /** Архивирует завершённый план на границе хода (onTurnEnd). */
  archiveCompletedPlan(): void;
  maybeSearchError: (ctx: ToolContext, call: ToolCall) => void;
}

/** Начальное состояние плагина: сидирует кулдауны теми же офсетами, с которыми плагин сравнивает. */
export function createExecutionPluginState(): ExecutionPluginState {
  return {
    lastRecoveryIteration: -STUCK_RECOVERY_COOLDOWN,
    lastTurnResetIteration: -1,
    lastRecoveryTurn: -1,
    lastStuckWarnTurn: -1,
    consecutivePlanWarnings: 0,
    lastStepId: -1,
    stuckNotified: false,
    lastStuckWarnKey: "",
    lastStuckWarnIter: -STUCK_WARN_REPEAT_EVERY,
    escalationDirectiveSent: false,
    depsGateHints: new Map<number, number>(),
    mutationsWithoutPlan: 0,
    planNudgeSent: false,
    typecheckFailures: new Map<string, string>(),
    mutatedThisTurn: false,
  };
}

export function resetStepFlags(state: ExecutionPluginState, stepId: number): void {
  state.consecutivePlanWarnings = 0;
  state.lastStepId = stepId;
  state.stuckNotified = false;
  state.escalationDirectiveSent = false;
}

/** Полный сброс состояния плана (завершён или его нет). */
export function resetPlanState(state: ExecutionPluginState): void {
  state.consecutivePlanWarnings = 0;
  state.lastStepId = -1;
  state.stuckNotified = false;
  state.mutationsWithoutPlan = 0;
  state.planNudgeSent = false;
  state.escalationDirectiveSent = false;
}
