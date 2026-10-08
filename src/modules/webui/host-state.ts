// Проекция host-снапшота для `mma web` (чистые функции: живое состояние → сайдбар).
/**
 * Вынесена из `module.ts` (правило #1: ≤300 строк/файл). Реэкспортируется из
 * `module.ts`, чтобы существующие импортёры не чинить.
 */
import type { AppConfig } from "../../config/types";
import type { AgentResult, ContextBreakdown } from "../../core/types";
import type { HostStateSnapshot, ProjectMapInfo } from "../../core/host";
import type { LspDiagnosis } from "../lsp/diagnose";
import type { SessionManager } from "../session/manager";
import type { ExecutionModule } from "../execution/module";
import { planSnapshotFromModule, adaptActivePlan } from "../../core/host-plan";
import { readMmaVersion } from "../../core/version";
import type { UsageSnapshot } from "./state";
import { isI18nStale } from "./i18n/i18n-stale";

/**
 * Узкие входы, читаемые `buildHostState`. Отдельно от `WebUiDeps`, чтобы
 * проекцию можно было тестировать без конструирования целого `Agent`.
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
  /** Конкретная сессия (веб-вкладка); без неё — активная. */
  sessionId?: string;
}

/** Структурное подмножество индексер-модуля для сайдбара (без жёсткой зависимости). */
export interface WebIndexer {
  buildIndex(): Promise<unknown>;
  stats(): { files: number; symbols: number; tokens: number } | null;
  /** Полная статистика карты (вкладка Map); undefined у старых стабов. */
  mapInfo?(): ProjectMapInfo;
  /** Принудительная пересборка индекса (`POST /api/index`). */
  refresh?(): Promise<unknown>;
  /** Подписка на изменения файлов (вотчер). Есть у `IndexerModule`, нет у стабов. */
  watch?(onSettled?: () => void): void;
  /** Отписка от вотчера. */
  unwatch?(): void;
}

/** Узкое подмножество LSP-модуля для вкладки LSP (`/api/lsp/doctor`). */
export interface WebLsp {
  diagnose(baseDir: string): Promise<LspDiagnosis>;
  /** Живой тумблер глобального LSP. Может отсутствовать у старых стабов. */
  setEnabled?(enabled: boolean): void;
  /** Живой тумблер офлайн-режима. Может отсутствовать у старых стабов. */
  setOffline(offline: boolean): void;
  /** Текущие флаги для ответа `GET /api/lsp/doctor`. */
  getFlags?(): { enabled: boolean; offline: boolean };
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
 * `ContextManager`, чтобы не тянуть весь класс в проекцию сайдбара).
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
    instructions: deps.instructions,
    projectMap: deps.projectMap ?? undefined,
    filesRevision: deps.filesRevision,
    i18nStale: isI18nStale(),
    plan: planSnapshotFromModule(adaptActivePlan(deps.execModule?.getActivePlan())),
  };
}
