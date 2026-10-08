/** MoE-путь агента: план → валидация → исполнение → верификация с re-plan. */
import type { AppConfig } from "../config/types";
import type { LLMProvider } from "../llm/provider";
import type { ToolExecutor } from "../tools/executor";
import type { Logger } from "../logger/app-logger";
import type { ToolEvent, AgentPhase, AgentResult, OnMeta } from "./types";
import { OrchestratorClient } from "../llm/orchestrator";
import { resolveProviderRef } from "../modules/providers/resolve-ref";
import { validatePlan, applyAutoFixes } from "../modules/execution/plan-validator";
import { MoEExecutor } from "../modules/execution/moe-executor";
import { StepVerifier } from "../modules/execution/verifier";
import type { MoEPlan, SubtaskResult, PlanResult } from "../modules/execution/types";
import type { VerifyInput, OrchestratorResult } from "../llm/types";
import { newAbortError, type TagUsage } from "../modules/execution/moe-executor";
import { isInfraError } from "../modules/execution/transient-error";
import {
  applyExpertModelCheck,
  checkExpertModels,
  describeExpertModelReplacement,
} from "../modules/execution/expert-model-check";
import { t } from "../i18n/index";
import { errMsg } from "../utils";

/** Дефолтный лимит циклов re-plan MoE. */
export const DEFAULT_MOE_MAX_REPLAN_CYCLES = 3;

/** Типы MoE-событий наблюдаемости в session.jsonl (Plan 4.2). */
export type MoEEventType = "moe_plan" | "moe_subtask" | "moe_replan" | "moe_verify";

/** Событие MoE: тип и данные для session log. */
export interface MoEEvent {
  type: MoEEventType;
  data: Record<string, unknown>;
}

/** Минимальная поверхность коллабораторов MoE — шов для подмен в тестах. */
export interface MoEOrchestratorLike {
  isEnabled(): boolean;
  plan(input: string, context?: string, signal?: AbortSignal): Promise<{ plan: MoEPlan; raw: string } | { error: string }>;
  verifyAndMerge(input: VerifyInput, signal?: AbortSignal): Promise<OrchestratorResult>;
  resolveScopeRequest(
    subtaskId: string,
    request: { files: string[]; read_only: boolean; reason: string },
    signal?: AbortSignal,
  ): Promise<
    | { action: "approve"; write: string[]; read: string[] }
    | { action: "reject"; explanation?: string }
  >;
}

/** Шов исполнителя плана MoE для тестов. */
export interface MoEExecutorLike {
  executePlan(
    plan: MoEPlan,
    opts?: { skipIds?: ReadonlySet<string>; carriedResults?: SubtaskResult[] },
  ): Promise<PlanResult>;
  getUsageByTag?(): Record<string, TagUsage>;
}

/** Шов верификатора манифеста MoE для тестов. */
export interface MoEVerifierLike {
  verifyMoEManifest(
    plan: MoEPlan,
    config: AppConfig,
    allToolTags: string[],
  ): Promise<{ success: boolean; errors: string[]; warnings: string[] }>;
}

/** Зависимости MoE-пути: конфиг, провайдер, тулы, логгер, швы тестов. */
export interface MoEDeps {
  config: AppConfig;
  llmProvider: LLMProvider;
  toolExecutor: ToolExecutor;
  logger: Logger;
  baseDir: string;
  /** Тестовые швы — при задании заменяют реальных коллабораторов. */
  orchestratorOverride?: MoEOrchestratorLike;
  executorOverride?: MoEExecutorLike;
  verifierOverride?: MoEVerifierLike;
}

/**
 * Исполняет MoE-путь (Mixture of Experts): план → валидация → исполнение →
 * верификация, с re-plan циклом по решению verifyAndMerge оркестратора.
 * Возвращает сигнал фолбэка, когда MoE не может продолжить: вызывающий
 * откатывается в одиночный цикл агента.
 *
 * `onMoEState` — факт «MoE ведёт этот ход» (не `moe.enabled`): веб рисует по
 * нему чип режима. Ставится после успешного плана и гасится в `finally`,
 * поэтому фолбэк, ошибка и Esc не оставляют чип гореть.
 */
export async function runWithMoE(
  deps: MoEDeps,
  input: string,
  fallback: () => Promise<AgentResult>,
  opts: {
    onMeta?: OnMeta;
    onTool?: (ev: ToolEvent) => void;
    onPhase?: (phase: AgentPhase) => void;
    /** Abort-сигнал (Esc / shutdown). AbortError пробрасывается — без MoE-фолбэка. */
    signal?: AbortSignal;
    /** Sink наблюдаемости — Agent.run вешает сюда SessionLogger.logMoE. */
    onEvent?: (event: MoEEvent) => void;
    /** Реальный id сессии, прокидывается субагентам для аудита/артефактов. */
    sessionId?: string;
    /** Факт «MoE ведёт ход»: true после успешного плана, false в `finally`. */
    onMoEState?: (active: boolean) => void;
  } = {},
): Promise<AgentResult> {
  let active = false;
  const setActive = (next: boolean): void => {
    if (active === next) return;
    active = next;
    opts.onMoEState?.(next);
  };
  let moeStarted = false;
  const markStarted = (): void => {
    moeStarted = true;
  };
  try {
    return await runMoECycles(deps, input, fallback, opts, setActive, markStarted);
  } catch (err) {
    // Ход MoE не дошёл до финала (Esc, краш, обрыв). Без этой записи
    // session.jsonl обрывается на последнем `moe_subtask: start`, и при
    // разборе сессии/в web-транскрипте не видно ни ответа, ни причины
    // (наблюдалось в ses_muz7sg1l_0ankgu).
    const aborted = err instanceof Error && err.name === "AbortError";
    if (moeStarted) {
      const reason = aborted ? t("moe.aborted") : errMsg(err);
      opts.onEvent?.({
        type: "moe_verify",
        data: { decision: aborted ? "aborted" : "error", explanation: reason },
      });
    }
    throw err;
  } finally {
    setActive(false);
  }
}

/** Тело MoE-цикла. `setActive(true)` — только после валидного плана. */
async function runMoECycles(
  deps: MoEDeps,
  input: string,
  fallback: () => Promise<AgentResult>,
  opts: {
    onMeta?: OnMeta;
    onTool?: (ev: ToolEvent) => void;
    onPhase?: (phase: AgentPhase) => void;
    signal?: AbortSignal;
    onEvent?: (event: MoEEvent) => void;
    sessionId?: string;
  },
  setActive: (active: boolean) => void,
  markStarted: () => void,
): Promise<AgentResult> {
  const { config, llmProvider, logger, toolExecutor, baseDir } = deps;
  const { onMeta, onPhase, onTool, signal, onEvent, sessionId } = opts;
  const emit = (type: MoEEventType, data: Record<string, unknown>) =>
    onEvent?.({ type, data });
  const ensureNotAborted = () => {
    if (signal?.aborted) throw newAbortError();
  };
  // Однострочники оркестрации — machine-facing: в чат только при
  // включённом verbose UI (config.ui.verbose). Пользовательские строки
  // прогресса (старт/финал хода) идут мимо `status` — см. `announce`.
  const verbose = config.ui?.verbose === true;
  const status = (message: string) => {
    if (verbose) onMeta?.(message);
  };

  let announced = false;
  /** Финальная строка хода: успех, частичный результат или обрыв. */
  const finish = (kind: "ok" | "partial" | "error") => {
    if (!announced) return;
    const done = [...mergedResults.values()].filter((r) => r.success).length;
    const total = mergedResults.size;
    if (kind === "ok") {
      onMeta?.(t("moe.finished", { done: String(done), total: String(total) }));
    } else if (kind === "partial") {
      onMeta?.(t("moe.finished_partial", { done: String(done), total: String(total) }));
    } else {
      onMeta?.(t("moe.finished_error"));
    }
  };

  ensureNotAborted();

  // Модели экспертов против списка моделей активного провайдера. Проверка
  // одноразовая на ход и fail-open: неизвестная модель эксперта заменяется на
  // активную с warn, вместо того чтобы трижды упасть с `Failed to load model`
  // и утянуть ход в re-plan (наблюдалось в ses_muz7sg1l_0ankgu).
  let moeConfig: AppConfig = config;
  let expertModelsChecked = false;
  const ensureExpertModels = async (): Promise<AppConfig> => {
    if (expertModelsChecked) return moeConfig;
    expertModelsChecked = true;
    let available: string[] | null = null;
    try {
      const models = await Promise.race([
        llmProvider.listModels(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000).unref?.()),
      ]);
      if (Array.isArray(models)) available = models;
    } catch {
      available = null;
    }
    const check = checkExpertModels(config, available);
    if (Object.keys(check.replaced).length > 0) {
      logger.warn(
        describeExpertModelReplacement(check.replaced, config.model, available ?? []),
      );
      moeConfig = applyExpertModelCheck(config, check);
    }
    return moeConfig;
  };

  await ensureExpertModels();

  let orchestrator: MoEOrchestratorLike | undefined = deps.orchestratorOverride;
  if (!orchestrator) {
    orchestrator = new OrchestratorClient(
      {
        model: config.orchestrator.model,
        provider: resolveProviderRef(config, config.orchestrator.provider),
        // Включённый MoE без orchestrator.model стартует на активной модели
        // агента, а не откатывается в одиночный режим молча.
        fallbackModel: config.model,
        fallbackProvider: config.provider,
        contextWindow: config.orchestrator.contextWindow,
        retry: config.retry,
        rateLimits: config.security?.rateLimits,
        logger,
        experts: moeConfig.experts,
      },
      llmProvider,
      { getSessionId: () => sessionId },
    );
  }

  if (!orchestrator.isEnabled()) {
    // Видно на дефолтном лог-уровне: включивший moe.enabled должен понимать,
    // почему MoE не стартовал (нет orchestrator.model).
    logger.warn(t("moe.no_orchestrator"));
    return fallback();
  }

  // Планирование отдельной строкой не печатается: его покрывает спиннер
  // thinking (`onPhase`), а пользователю нужна одна строка на ход.
  onPhase?.("thinking");
  const planResult = await orchestrator.plan(input, undefined, signal);
  onPhase?.("done");

  if ("error" in planResult) {
    logger.warn(t("moe.plan_failed", { error: planResult.error }));
    emit("moe_plan", { status: "error", error: planResult.error });
    return fallback();
  }
  emit("moe_plan", {
    status: "ok",
    title: planResult.plan.title,
    subtaskIds: planResult.plan.subtasks.map((s) => s.id),
  });

  const maxCycles = Math.max(
    1,
    config.moe?.maxReplanCycles ?? DEFAULT_MOE_MAX_REPLAN_CYCLES,
  );
  const mergedResults = new Map<string, SubtaskResult>();

  let currentPlan: MoEPlan = planResult.plan;
  const usageByTag: Record<string, TagUsage> = {};
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    ensureNotAborted();
    if (cycle > 1) {
      status(`${t("moe.replan_started", { cycle, max: maxCycles })}\n`);
      emit("moe_replan", {
        cycle,
        title: currentPlan.title,
        subtaskIds: currentPlan.subtasks.map((s) => s.id),
      });
    }

    // Валидируем каждый план до исполнения — LLM-плану не доверяем никогда,
    // включая re-plan от verifyAndMerge.
    const validation = validatePlan(currentPlan, moeConfig);
    if (!validation.valid) {
      const applied = applyAutoFixes(currentPlan, validation.autoFixes);
      const retry = validatePlan(applied, moeConfig);
      if (!retry.valid) {
        logger.diagnostic("warn", `MoE plan validation failed: ${retry.errors.join("; ")}`);
        if (cycle === 1) {
          status(t("moe.plan_fallback"));
          return fallback();
        }
        finish("partial");
        return partialFailure(mergedResults, retry.errors.join("; "));
      }
      currentPlan = applied;
      if (validation.autoFixes.length > 0) {
        status(t("moe.plan_autofixed", { count: String(validation.autoFixes.length) }));
      }
    }

    // Валидация прошла — MoE реально ведёт ход: одна строка в чат (на весь
    // ход, не на цикл) и факт «режим включён» для индикатора. Re-plan циклы
    // молчат: пользователь уже видит, что оркестрация идёт.
    if (!announced) {
      announced = true;
      setActive(true);
      markStarted();
      onMeta?.(t("moe.started", { count: String(currentPlan.subtasks.length) }));
    }

    const executor: MoEExecutorLike =
      deps.executorOverride ??
      new MoEExecutor({
        config: moeConfig,
        toolRegistry: toolExecutor.getRegistry(),
        toolExecutor,
        llmProvider,
        logger,
        baseDir,
        onTool,
        sessionId,
        onEvent: (e) => emit(e.type, e.data),
        onScopeRequest: async (subtaskId, req) => {
          const decision = await orchestrator.resolveScopeRequest(subtaskId, req, signal);
          if (decision.action === "approve") {
            status(
              `${t("moe.scope_approved", {
                subtask: subtaskId,
                files: [...decision.write, ...decision.read].join(", "),
              })}\n`,
            );
          } else {
            status(`${t("moe.scope_rejected", { subtask: subtaskId })}\n`);
          }
          return decision;
        },
      });

    // Старт хода уже отдан строкой выше — промежуточный «executing» не печатаем.

    // Селективный re-plan (Plan 5.1): успешные сабтаски прошлого цикла
    // переносятся — переисполняются только упавшие/новые.
    const skipIds = new Set<string>();
    const carriedResults: SubtaskResult[] = [];
    for (const s of currentPlan.subtasks) {
      const prev = mergedResults.get(s.id);
      if (prev?.success) {
        skipIds.add(s.id);
        carriedResults.push(prev);
      }
    }
    for (const id of skipIds) {
      emit("moe_subtask", { subtaskId: id, status: "carried", cycle });
    }

    const planResults = await executor.executePlan(currentPlan, { skipIds, carriedResults });
    ensureNotAborted();
    const cycleUsage = executor.getUsageByTag?.();
    if (cycleUsage) {
      for (const [tag, usage] of Object.entries(cycleUsage)) {
        const agg = usageByTag[tag] ?? {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          subtasks: 0,
        };
        agg.promptTokens += usage.promptTokens;
        agg.completionTokens += usage.completionTokens;
        agg.totalTokens += usage.totalTokens;
        agg.subtasks += usage.subtasks;
        usageByTag[tag] = agg;
      }
    }
    for (const r of planResults.results) {
      mergedResults.set(r.subtaskId, r);
    }
    // Итог печатает финальная строка хода (`finish`) — здесь считать рано:
    // verifyAndMerge может вернуть re-plan, и ход ещё не закончен.

    // Инфраструктурный фейл: re-plan не поможет — следующий план уйдёт на тот
    // же сломанный/перегруженный провайдер (наблюдалось: оба сабтаска упали по
    // mid-stream обрыву, оркестратор объявил re-plan и повторил то же самое за
    // 13 секунд). Верификатор не зовём — он бы выдумал причину и вернул
    // re-plan; вместо этого честный partial с РЕАЛЬНЫМ текстом ошибки.
    const failedResults = [...mergedResults.values()].filter((r) => !r.success);
    if (failedResults.length > 0 && failedResults.every((r) => isInfraError(r.error || r.summary))) {
      const reason = t("moe.infra_failure", {
        count: String(failedResults.length),
        error: firstLine(failedResults.map((r) => r.error || r.summary).join(" | ")),
      });
      logger.warn(reason);
      emit("moe_verify", {
        decision: "infra_failure",
        explanation: reason,
        failedSubtaskIds: failedResults.map((r) => r.subtaskId),
      });
      const anySuccess = [...mergedResults.values()].some((r) => r.success);
      finish(anySuccess ? "partial" : "error");
      return partialFailure(mergedResults, reason);
    }

    const verifier: MoEVerifierLike =
      deps.verifierOverride ??
      new StepVerifier(baseDir);
    const knownTags = collectKnownToolTags(toolExecutor);
    const verification = await verifier.verifyMoEManifest(currentPlan, moeConfig, knownTags);

    onPhase?.("thinking");
    ensureNotAborted();
    let verifyResult: OrchestratorResult;
    try {
      verifyResult = await orchestrator.verifyAndMerge({
        plan: currentPlan,
        results: [...mergedResults.values()].map((r) => ({
          subtaskId: r.subtaskId,
          success: r.success,
          summary: r.summary,
          result: r.result,
          error: r.error,
        })),
        verifierErrors: verification.errors,
        verifierWarnings: verification.warnings,
        // Упавшие по контентным причинам сабтаски: только их имеет смысл
        // перепланировать. Инфраструктурные фейлы выше уже остановлены.
        failedSubtaskIds: failedResults.map((r) => r.subtaskId),
      }, signal);
    } catch (err: any) {
      onPhase?.("done");
      if (err?.name === "AbortError") throw err;
      emit("moe_verify", { status: "error", error: err.message });
      finish("error");
      return {
        success: false,
        text: `MoE verifyAndMerge crashed: ${err.message}`,
        error: err.message,
        iterationCount: mergedResults.size,
      };
    }
    onPhase?.("done");
    emit("moe_verify", {
      decision: verifyResult.type,
      explanation: verifyResult.explanation,
      usageByTag: Object.keys(usageByTag).length > 0 ? usageByTag : undefined,
    });

    if (verifyResult.type === "final") {
      finish("ok");
      return buildFinalResult(mergedResults, verification.success, verifyResult);
    }

    if (!verifyResult.plan || !Array.isArray(verifyResult.plan.subtasks)) {
      // Верификатор просил re-plan, но годного не дал — останавливаемся честно.
      finish("partial");
      return partialFailure(
        mergedResults,
        verifyResult.explanation || "re-plan requested but no plan returned",
      );
    }
    currentPlan = verifyResult.plan;
  }

  finish("partial");
  return partialFailure(mergedResults, t("moe.cycles_exhausted", { max: String(maxCycles) }));
}

function collectKnownToolTags(toolExecutor: ToolExecutor): string[] {
  const tags = new Set<string>();
  for (const tool of toolExecutor.getRegistry().getAll()) {
    for (const tag of tool.tags || []) tags.add(tag);
  }
  return Array.from(tags);
}

function buildFinalResult(
  mergedResults: Map<string, SubtaskResult>,
  verificationSuccess: boolean,
  verifyResult: { finalAnswer?: string },
): AgentResult {
  const failedCount = [...mergedResults.values()].filter((r) => !r.success).length;
  return {
    success: failedCount === 0 && verificationSuccess,
    text: renderMoEResults(mergedResults, "Result", verifyResult.finalAnswer || "Complete"),
    iterationCount: mergedResults.size,
    moeHandled: true,
  };
}

function partialFailure(mergedResults: Map<string, SubtaskResult>, reason: string): AgentResult {
  return {
    success: false,
    text: renderMoEResults(mergedResults, t("moe.partial_result"), reason),
    error: reason,
    iterationCount: mergedResults.size,
    moeHandled: true,
  };
}

/**
 * Единый рендер итогов MoE для финала и partial-фейла. Упавший сабтаск
 * показывается с ПРИЧИНОЙ, а не только с `summary` вида «Failed: task-2»:
 * иначе пользователь и модель видят факт без причины (и выдумывают её).
 */
function renderMoEResults(
  mergedResults: Map<string, SubtaskResult>,
  resultLabel: string,
  reason: string,
): string {
  const outputLines: string[] = [`## MoE Execution Results\n`];
  for (const r of mergedResults.values()) {
    const icon = r.success ? "✅" : "❌";
    const detail = r.success ? r.summary : firstLine(r.error || r.summary);
    outputLines.push(`${icon} **${r.subtaskId}**: ${detail} (${r.durationMs}ms)`);
  }
  outputLines.push("");
  outputLines.push(`**${resultLabel}:** ${reason}`);
  return outputLines.join("\n");
}

/** Первая непустая строка текста, обрезанная до разумной длины. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
