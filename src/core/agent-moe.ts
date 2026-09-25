import type { AppConfig } from "../config/types";
import type { LLMProvider } from "../llm/provider";
import type { ToolExecutor } from "../tools/executor";
import type { Logger } from "../logger/app-logger";
import type { ToolEvent, AgentPhase, AgentResult } from "./types";
import { OrchestratorClient } from "../llm/orchestrator";
import { validatePlan, applyAutoFixes } from "../modules/execution/plan-validator";
import { MoEExecutor } from "../modules/execution/moe-executor";
import { StepVerifier } from "../modules/execution/verifier";
import type { MoEPlan, SubtaskResult, PlanResult } from "../modules/execution/types";
import type { VerifyInput, OrchestratorResult } from "../llm/types";
import { newAbortError, type TagUsage } from "../modules/execution/moe-executor";
import { t } from "../i18n/index";

export const DEFAULT_MOE_MAX_REPLAN_CYCLES = 3;

/** MoE observability event types written to session.jsonl (Plan 4.2). */
export type MoEEventType = "moe_plan" | "moe_subtask" | "moe_replan" | "moe_verify";

export interface MoEEvent {
  type: MoEEventType;
  data: Record<string, unknown>;
}

/** Minimal structural surface of the collaborators, for test seam injection. */
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

export interface MoEExecutorLike {
  executePlan(
    plan: MoEPlan,
    opts?: { skipIds?: ReadonlySet<string>; carriedResults?: SubtaskResult[] },
  ): Promise<PlanResult>;
  getUsageByTag?(): Record<string, TagUsage>;
}

export interface MoEVerifierLike {
  verifyMoEManifest(
    plan: MoEPlan,
    config: AppConfig,
    allToolTags: string[],
  ): Promise<{ success: boolean; errors: string[]; warnings: string[] }>;
}

export interface MoEDeps {
  config: AppConfig;
  llmProvider: LLMProvider;
  toolExecutor: ToolExecutor;
  logger: Logger;
  baseDir: string;
  /** Test seams — when set, replace the real collaborators. */
  orchestratorOverride?: MoEOrchestratorLike;
  executorOverride?: MoEExecutorLike;
  verifierOverride?: MoEVerifierLike;
}

/**
 * Execute the MoE (Mixture of Experts) path: plan → validate → execute → verify,
 * with a re-plan loop driven by the orchestrator's verifyAndMerge decision.
 * Returns a fallback signal when MoE cannot proceed so the caller can fall
 * back to the single-agent loop.
 */
export async function runWithMoE(
  deps: MoEDeps,
  input: string,
  fallback: () => Promise<AgentResult>,
  opts: {
    onMeta?: (meta: string) => void;
    onTool?: (ev: ToolEvent) => void;
    onPhase?: (phase: AgentPhase) => void;
    /** Abort signal (Esc / shutdown). AbortError propagates — no MoE fallback. */
    signal?: AbortSignal;
    /** Observability sink — wired to SessionLogger.logMoE by Agent.run. */
    onEvent?: (event: MoEEvent) => void;
    /** Real session id, propagated to sub-agents for audit/artifacts. */
    sessionId?: string;
  } = {},
): Promise<AgentResult> {
  const { config, llmProvider, logger, toolExecutor, baseDir } = deps;
  const { onMeta, onPhase, onTool, signal, onEvent, sessionId } = opts;
  const emit = (type: MoEEventType, data: Record<string, unknown>) =>
    onEvent?.({ type, data });
  const ensureNotAborted = () => {
    if (signal?.aborted) throw newAbortError();
  };
  // Orchestration one-liners are machine-facing: emit them to the chat only
  // when the user opted into verbose UI (config.ui.verbose).
  const verbose = config.ui?.verbose === true;
  const status = (message: string) => {
    if (verbose) onMeta?.(message);
  };

  ensureNotAborted();

  let orchestrator: MoEOrchestratorLike | undefined = deps.orchestratorOverride;
  if (!orchestrator) {
    orchestrator = new OrchestratorClient(
      {
        model: config.orchestrator.model,
        provider: config.orchestrator.provider,
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
    // Visible at default log level: a user who enabled moe.enabled must be
    // able to tell why MoE never kicked in (missing orchestrator.model).
    logger.warn(t("moe.no_orchestrator"));
    return fallback();
  }

  status(t("moe.planning"));
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

    // Validate every plan before executing it — never trust an LLM-produced
    // plan, including re-plans produced by verifyAndMerge.
    const validation = validatePlan(currentPlan, config);
    if (!validation.valid) {
      const applied = applyAutoFixes(currentPlan, validation.autoFixes);
      const retry = validatePlan(applied, config);
      if (!retry.valid) {
        logger.warn(`MoE plan validation failed: ${retry.errors.join("; ")}`);
        if (cycle === 1) {
          status(t("moe.plan_fallback"));
          return fallback();
        }
        return partialFailure(mergedResults, retry.errors.join("; "));
      }
      currentPlan = applied;
      if (validation.autoFixes.length > 0) {
        status(t("moe.plan_autofixed", { count: String(validation.autoFixes.length) }));
      }
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

    status(
      `${t("moe.executing", { count: String(currentPlan.subtasks.length), cycle: String(cycle) })}\n`,
    );

    // Selective re-plan (Plan 5.1): subtasks already successfully executed in
    // an earlier cycle are carried over — only failed/new ones re-execute.
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
    const succeeded = [...mergedResults.values()].filter((r) => r.success).length;
    status(
      `✅ ${t("moe.execution_complete", { succeeded: String(succeeded), total: String(mergedResults.size) })}\n`,
    );

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
      return buildFinalResult(mergedResults, verification.success, verifyResult);
    }

    if (!verifyResult.plan || !Array.isArray(verifyResult.plan.subtasks)) {
      // Verifier asked for a re-plan but produced none usable — stop honestly.
      return partialFailure(
        mergedResults,
        verifyResult.explanation || "re-plan requested but no plan returned",
      );
    }
    currentPlan = verifyResult.plan;
  }

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
