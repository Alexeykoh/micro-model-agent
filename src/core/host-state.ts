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
import type { AgentResult, ContextBreakdown, ContextQualityBreakdown, LlmSpeedSnapshot } from "./types";
import type { HostStateSnapshot, ProjectMapInfo } from "./host";
import type { GitSnapshot } from "../tools/git-core";
import type { SessionManager } from "../modules/session/manager";
import type { ExecutionModule } from "../modules/execution/module";
import { planSnapshotFromModule, adaptActivePlan } from "./host-plan";
import { isDevBuild, readMmaVersion } from "./version";

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
  /** Накопленные входящие токены за сессию (prompt). Персистится. */
  promptTokensTotal?: number;
  /** Накопленные исходящие токены за сессию (completion, с reasoning). Персистится. */
  completionTokensTotal?: number;
  /** Накопленные кэшированные токены за сессию. Персистится. */
  cachedTokensTotal?: number;
  contextQuality?: number;
  contextQualityBreakdown?: ContextQualityBreakdown;
  contextBreakdown?: ContextBreakdown;
  /** Скорость генерации последнего хода (decode без префилла). */
  llmSpeed?: LlmSpeedSnapshot;
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
  /** Снимок git из серверного кеша (чипы/вкладка Changes); undefined — не собирали. */
  git?: GitSnapshot | null;
  /** Конкретная сессия; без неё — активная. */
  sessionId?: string;
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
export function captureUsage(
  result: AgentResult,
  fallbackLimit?: number,
  prev?: UsageSnapshot,
): UsageSnapshot {
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
  if (result.contextQualityBreakdown) usage.contextQualityBreakdown = result.contextQualityBreakdown;
  if (result.contextBreakdown) usage.contextBreakdown = result.contextBreakdown;
  if (result.llmSpeed) usage.llmSpeed = result.llmSpeed;
  // Накопленные токены сессии: per-turn дельты (из AgentResult) + база сессии.
  // База — предыдущий снимок той же сессии (включая поднятый с диска после
  // reload), чтобы счёт не обнулялся. Нет дельты — поле опускается.
  const inDelta = typeof result.promptTokens === "number" ? result.promptTokens : undefined;
  const outDelta = typeof result.completionTokens === "number" ? result.completionTokens : undefined;
  const cachedDelta = typeof result.cache?.cachedTokens === "number" ? result.cache.cachedTokens : undefined;
  if (inDelta !== undefined) usage.promptTokensTotal = (prev?.promptTokensTotal ?? 0) + inDelta;
  if (outDelta !== undefined) usage.completionTokensTotal = (prev?.completionTokensTotal ?? 0) + outDelta;
  if (cachedDelta !== undefined) usage.cachedTokensTotal = (prev?.cachedTokensTotal ?? 0) + cachedDelta;
  // Нет дельт — сохраняем базу, чтобы частичный вход не гасил тоталы.
  if (inDelta === undefined && typeof prev?.promptTokensTotal === "number") usage.promptTokensTotal = prev.promptTokensTotal;
  if (outDelta === undefined && typeof prev?.completionTokensTotal === "number") usage.completionTokensTotal = prev.completionTokensTotal;
  if (cachedDelta === undefined && typeof prev?.cachedTokensTotal === "number") usage.cachedTokensTotal = prev.cachedTokensTotal;
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
    qualityBreakdown: ContextQualityBreakdown;
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
    contextQualityBreakdown: snap.qualityBreakdown,
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
    promptTokensTotal: deps.usage?.promptTokensTotal,
    completionTokensTotal: deps.usage?.completionTokensTotal,
    cachedTokensTotal: deps.usage?.cachedTokensTotal,
    contextQuality: deps.usage?.contextQuality,
    contextQualityBreakdown: deps.usage?.contextQualityBreakdown,
    contextBreakdown: deps.usage?.contextBreakdown,
    llmSpeed: deps.usage?.llmSpeed,
    contextProbe: deps.contextProbe,
    workspace: deps.workspace,
    version: readMmaVersion(),
    dev: isDevBuild(),
    updateAvailable: deps.updateAvailable,
    instructions: deps.instructions,
    projectMap: deps.projectMap ?? undefined,
    filesRevision: deps.filesRevision,
    git: deps.git,
    i18nStale: deps.i18nStale,
    plan: planSnapshotFromModule(adaptActivePlan(deps.execModule?.getActivePlan())),
  };
}