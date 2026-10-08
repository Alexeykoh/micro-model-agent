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
import { t } from "../i18n/index";

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
  try {
    return await runMoECycles(deps, input, fallback, opts, setActive);
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
        experts: config.experts,
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
    const validation = validatePlan(currentPlan, config);
    if (!validation.valid) {
      const applied = applyAutoFixes(currentPlan, validation.autoFixes);
      const retry = validatePlan(applied, config);
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
      onMeta?.(t("moe.started", { count: String(currentPlan.subtasks.length) }));
    }

    const executor: MoEExecutorLike =
      deps.executorOverride ??
      new MoEExecutor({
        config,
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

    const verifier: MoEVerifierLike =
      deps.verifierOverride ??
      new StepVerifier(baseDir);
    const knownTags = collectKnownToolTags(toolExecutor);
    const verification = await verifier.verifyMoEManifest(currentPlan, config, knownTags);

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
  const outputLines: string[] = [`## MoE Execution Results\n`];
  for (const r of mergedResults.values()) {
    const icon = r.success ? "✅" : "❌";
    outputLines.push(`${icon} **${r.subtaskId}**: ${r.summary} (${r.durationMs}ms)`);
  }
  outputLines.push("");
  outputLines.push(`**Result:** ${verifyResult.finalAnswer || "Complete"}`);

  const failedCount = [...mergedResults.values()].filter((r) => !r.success).length;
  return {
    success: failedCount === 0 && verificationSuccess,
    text: outputLines.join("\n"),
    iterationCount: mergedResults.size,
    moeHandled: true,
  };
}

function partialFailure(mergedResults: Map<string, SubtaskResult>, reason: string): AgentResult {
  const outputLines: string[] = [`## MoE Execution Results\n`];
  for (const r of mergedResults.values()) {
    const icon = r.success ? "✅" : "❌";
    outputLines.push(`${icon} **${r.subtaskId}**: ${r.summary} (${r.durationMs}ms)`);
  }
  outputLines.push("");
  outputLines.push(`**${t("moe.partial_result")}:** ${reason}`);
  return {
    success: false,
    text: outputLines.join("\n"),
    error: reason,
    iterationCount: mergedResults.size,
    moeHandled: true,
  };
}
