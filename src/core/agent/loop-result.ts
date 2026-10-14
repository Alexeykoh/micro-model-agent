/**
 * Сборка итога одиночного цикла хода (`TurnCoordinator`, INV-23): метрики
 * контекста/стоимости/кэша и `AgentResult` (в т.ч. ветка исчерпания итераций).
 * Вынесено из `core/agent.ts`.
 */
import type { AgentDeps } from "../agent";
import type { AgentResult } from "../types";
import type { LoopState } from "./loop-state";
import type { TokenTracker } from "./token-tracker";
import type { CostTracker } from "../../modules/pricing/index";
import { computeCacheStats } from "./cache-stats";
import { t } from "../../i18n/index";

/** Мутабельный вид `Agent`, которым владеет сборка результата. */
export interface LoopResultHost {
  deps: AgentDeps;
  costTracker: CostTracker;
  isShutdownRequested(): boolean;
}

/**
 * Собирает `AgentResult`: `maxItersExhausted` выбирает ветку «лимит итераций
 * исчерпан без финального ответа» (иначе — обычный итог).
 */
export function buildLoopResult(
  host: LoopResultHost,
  state: LoopState,
  tokenTracker: TokenTracker,
  maxItersExhausted: boolean,
): AgentResult {
  const { contextManager } = host.deps;
  const config = host.deps.config;
  const tokensUsed = contextManager.getEstimatedTokens();
  const budget = contextManager.getBudget();
  const usageTokens = tokenTracker.resolveFinal(state);
  const cacheStats = computeCacheStats(state, host.costTracker.saved);

  const stopError =
    state.stopReason && !state.finalAnswerAccepted
      ? state.stopReason === "duplicate"
        ? t("error.readonly_loop_stopped", { count: state.consecutiveDuplicateBatches })
        : state.stopReason === "failed_batches"
          ? t("error.retry_loop_stopped", { count: state.consecutiveFailedBatches })
          : t("error.max_iters", { max: config.maxToolIterations })
      : undefined;

  if (maxItersExhausted) {
    return {
      success: false,
      text: state.lastText,
      error: stopError ?? t("error.max_iters", { max: config.maxToolIterations }),
      stopReason: state.stopReason ?? "max_iters",
      iterationCount: state.iteration,
      contextUsed: tokensUsed,
      contextLimit: budget.history,
      promptTokens: usageTokens.prompt,
      completionTokens: usageTokens.completion,
      totalTokens: usageTokens.total,
      totalCost: host.costTracker.total,
      costBreakdown: host.costTracker.breakdown(),
      cache: cacheStats,
      compactionCount: contextManager.getCompactionCount(),
      contextQuality: contextManager.getQuality(),
      contextQualityBreakdown: contextManager.getQualityBreakdown?.(),
      contextBreakdown: contextManager.getBreakdown?.(),
    };
  }

  const shutdown = host.isShutdownRequested();
  return {
    success: !(shutdown || state.emptyResponseExhausted || state.auditFailed || !!stopError),
    interrupted: shutdown || undefined,
    text: state.lastText,
    stopReason: state.stopReason ?? undefined,
    error: stopError
      ? stopError
      : state.emptyResponseExhausted
        ? t("error.empty_response")
        : state.auditFailed
          ? t("error.audit_failed", { summary: state.lastAuditSummary })
          : undefined,
    iterationCount: state.iteration,
    contextUsed: tokensUsed,
    contextLimit: budget.history,
    promptTokens: usageTokens.prompt,
    completionTokens: usageTokens.completion,
    totalTokens: usageTokens.total,
    totalCost: host.costTracker.total,
    costBreakdown: host.costTracker.breakdown(),
    cache: cacheStats,
    compactionCount: contextManager.getCompactionCount(),
    contextQuality: contextManager.getQuality(),
    contextQualityBreakdown: contextManager.getQualityBreakdown?.(),
    contextBreakdown: contextManager.getBreakdown?.(),
    llmDurationMs: state.totalLlmDuration,
  };
}
