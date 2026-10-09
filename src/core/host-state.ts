// Проекция host-снапшота: живое состояние модулей → `HostStateSnapshot` (чистые функции).
/**
 * Фронтендонезависимое ядро проекции состояния. Изначально лежало в
 * `src/modules/webui/host-state.ts`, откуда его тянули и `mma web`, и `mma serve`
 * (`service/runtime/run-task.ts`) — структурный подмножество веб-модуля как
 * общий контракт. Вынесено в `core`, потому что снапшот нужен ЛЮБОМУ хосту
 * (REPL, TUI, web, serve), а web-специфичные вещи остались в webui:
 * `UsageSnapshot`-хранилище (`state.ts`), `isI18nStale` (словари браузера).
 *
 * Ничего здесь не знает про терминал, SSE или HTTP — только про модули.
 */
import type { AppConfig } from "../config/types";
import type { AgentResult, ContextBreakdown } from "./types";
import type { HostStateSnapshot, ProjectMapInfo } from "./host";
import type { SessionManager } from "../modules/session/manager";
import type { ExecutionModule } from "../modules/execution/module";
import { planSnapshotFromModule, adaptActivePlan } from "./host-plan";
import { readMmaVersion } from "./version";

/**
 * Метрики usage последнего хода из `AgentResult` для `HostStateSnapshot`.
 * Все поля опциональны: ход без значения оставляет ячейку UI на `—`.
 */
export interface UsageSnapshot {
  contextUsed?: number;
  contextLimit?: number;
  costUsd?: number;
  compactionCount?: number;
  cacheHitRate?: number;
  cacheSaved?: number;
  contextQuality?: number;
  contextBreakdown?: ContextBreakdown;
}

/**
 * Узкие входы, читаемые {@link buildHostState}. Отдельно от deps любого хоста,
 * чтобы проекцию можно было тестировать без конструирования целого `Agent`.
 */
export interface HostStateInput {
  config: AppConfig;
  sessionManager?: Pick<SessionManager, "getActiveMeta"> & Partial<Pick<SessionManager, "get">>;
  execModule?: Pick<ExecutionModule, "getActivePlan">;
  usage?: UsageSnapshot;
  contextProbe?: { model: string; actual: number } | null;
  workspace?: string;
  instructions?: { files: string[]; disabled: boolean };
  projectMap?: ProjectMapInfo | null;
  /** Счётчик изменений файлов workspace (см. `HostStateSnapshot.filesRevision`). */
  filesRevision?: number;
  /** Конкретная сессия; без неё — активная. */
  sessionId?: string;
  /** Факт «этим ходом руководит MoE» для чипа режима. */
  moeActive?: boolean;
  /** Доступный апдейт (текущая → свежая версия) для чипа в футере. */
  updateAvailable?: { current: string; latest: string };
  /**
   * Факт «i18n-словари на диске новее старта процесса». Фронтенд решает сам,
   * показывать ли это пользователю: веб показывает тост и шлёт словари заново,
   * терминал/се��вис — молча (перевод всё равно из памяти процесса).
   */
  i18nStale?: boolean;
}

/**
 * Забирает usage-носящее подмножество `AgentResult` в {@link UsageSnapshot}.
 * Undefined-поля опускаются, чтобы частичный результат не затирал известное
 * значение пустой ячейкой.
 */
export function captureUsage(result: AgentResult, fallbackLimit?: number): UsageSnapshot {
  const usage: UsageSnapshot = {};
  if (typeof result.contextUsed === "number") usage.contextUsed = result.contextUsed;
  const limit = typeof result.contextLimit === "number" ? result.contextLimit : fallbackLimit;
  if (typeof limit === "number") usage.contextLimit = limit;
  if (typeof result.totalCost === "number") usage.costUsd = result.totalCost;
  if (typeof result.compactionCount === "number") usage.compactionCount = result.compactionCount;
  if (result.cache) {
    if (typeof result.cache.hitRate === "number") usage.cacheHitRate = result.cache.hitRate;
    if (typeof result.cache.saved === "number") usage.cacheSaved = result.cache.saved;
  }
  if (typeof result.contextQuality === "number") usage.contextQuality = result.contextQuality;
  if (result.contextBreakdown) usage.contextBreakdown = result.contextBreakdown;
  return usage;
}

/**
 * Живой источник контекстных метрик во время хода (структурное подмножество
 * `ContextManager`, чтобы не тянуть весь класс в проекцию снапшота).
 */
export interface LiveContextSource {
  getSnapshot(): {
    tokens: number;
    budget: { history: number };
    quality: number;
    compactionCount: number;
    breakdown: ContextBreakdown;
  };
}

/**
 * Собирает живой usage-снимок контекста прямо из менеджера — для бродкаста
 * во время хода, не дожидаясь `AgentResult`. Cost/cache не трогаем: они
 * обновляются только по завершении хода (провайдерские числа). Предыдущий
 * снимок сохраняется, чтобы не гасить известные значения.
 */
export function liveContextUsage(
  prev: UsageSnapshot | undefined,
  context: LiveContextSource,
): UsageSnapshot {
  const snap = context.getSnapshot();
  return {
    ...prev,
    contextUsed: snap.tokens,
    contextLimit: snap.budget.history,
    contextBreakdown: snap.breakdown,
    compactionCount: snap.compactionCount,
    contextQuality: snap.quality,
  };
}

/**
 * Резолвит снапшот плана для бродкаста после конца тула. Активный план мутируют
 * только тулы `plan`/`plan_step`/`todo`, остальные дают `null` (без события).
 * Чистая, тестируется без подъёма агента/сервера.
 */
export function planEventFor(
  toolName: string,
  execModule?: Pick<ExecutionModule, "getActivePlan">,
): HostStateSnapshot["plan"] | null {
  if (toolName !== "plan" && toolName !== "plan_step" && toolName !== "todo") return null;
  return planSnapshotFromModule(adaptActivePlan(execModule?.getActivePlan()));
}

/** Строит host-снапшот из живого состояния модулей. */
export function buildHostState(deps: HostStateInput, busy: boolean): HostStateSnapshot {
  const meta =
    deps.sessionId && deps.sessionManager?.get
      ? deps.sessionManager.get(deps.sessionId)
      : deps.sessionManager?.getActiveMeta();
  return {
    busy,
    sessionId: meta?.id,
    sessionName: meta?.name,
    model: deps.config.model,
    provider: deps.config.provider?.active,
    contextWindow: deps.config.contextWindow,
    contextUsed: deps.usage?.contextUsed,
    contextLimit: deps.usage?.contextLimit,
    costUsd: deps.usage?.costUsd,
    compactionCount: deps.usage?.compactionCount,
    cacheHitRate: deps.usage?.cacheHitRate,
    contextQuality: deps.usage?.contextQuality,
    contextBreakdown: deps.usage?.contextBreakdown,
    contextProbe: deps.contextProbe,
    workspace: deps.workspace,
    version: readMmaVersion(),
    moeActive: deps.moeActive,
    updateAvailable: deps.updateAvailable,
    instructions: deps.instructions,
    projectMap: deps.projectMap ?? undefined,
    filesRevision: deps.filesRevision,
    i18nStale: deps.i18nStale,
    plan: planSnapshotFromModule(adaptActivePlan(deps.execModule?.getActivePlan())),
  };
}