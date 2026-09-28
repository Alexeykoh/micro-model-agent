// Проекция host-снапшота для `mma web` (чистые функции: живое состояние → сайдбар).
/**
 * Вынесена из `module.ts` (правило #1: ≤300 строк/файл). Реэкспортируется из
 * `module.ts`, чтобы существующие импортёры не чинить.
 */
import type { AppConfig } from "../../config/types";
import type { AgentResult } from "../../core/types";
import type { HostStateSnapshot } from "../../core/host";
import type { SessionManager } from "../../modules/session/manager";
import type { ExecutionModule } from "../../modules/execution/module";
import { planSnapshotFromModule, adaptActivePlan } from "../../core/host-plan";
import type { UsageSnapshot } from "./state";

/**
 * Узкие входы, читаемые `buildHostState`. Отдельно от `WebUiDeps`, чтобы
 * проекцию можно было тестировать без конструирования целого `Agent`.
 */
export interface HostStateInput {
  config: AppConfig;
  sessionManager?: Pick<SessionManager, "getActiveMeta">;
  execModule?: Pick<ExecutionModule, "getActivePlan">;
  usage?: UsageSnapshot;
  contextProbe?: { model: string; actual: number } | null;
  workspace?: string;
  instructions?: { files: string[]; disabled: boolean };
  projectMap?: { indexed: boolean; files: number; symbols: number; tokens: number } | null;
}

/** Структурное подмножество индексер-модуля для сайдбара (без жёсткой зависимости). */
export interface WebIndexer {
  buildIndex(): Promise<unknown>;
  stats(): { files: number; symbols: number; tokens: number } | null;
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
  return usage;
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
  const meta = deps.sessionManager?.getActiveMeta();
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
    contextProbe: deps.contextProbe,
    workspace: deps.workspace,
    instructions: deps.instructions,
    projectMap: deps.projectMap ?? undefined,
    plan: planSnapshotFromModule(adaptActivePlan(deps.execModule?.getActivePlan())),
  };
}
