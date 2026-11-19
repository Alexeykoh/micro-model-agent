/**
 * Вынужденный финал после исчерпания ходов (`TurnCoordinator`, INV-C7):
 * tool-less ответ → critic → audit → запись. Вынесено из `loop-run.ts`
 * (правило ≤300 строк), поведение прежнее.
 */
import type { AgentDeps } from "../agent";
import type { OnMeta, StopReason } from "../types";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";
import type { TokenTracker } from "./token-tracker";
import type { CriticGate } from "./critic-gate";
import type { AuditGate } from "./audit-gate";
import type { DraftSink } from "./draft-buffer";
import { gatherTurnToolEvents } from "./critic-events";
import { recordFinalAnswer } from "./turn-output";

export interface ForcedFinalInput {
  deps: AgentDeps;
  state: LoopState;
  tokenTracker: TokenTracker;
  slog: SessionLogger;
  criticGate: CriticGate;
  auditGate: AuditGate;
  draft: DraftSink;
  gateMeta?: OnMeta;
  input: string;
  reason: StopReason;
  finalize(onChunk?: (chunk: string) => void): Promise<string>;
  isShutdownRequested(): boolean;
}

/**
 * Запускает финальный проход; `true` — пользователь прервал ход сразу после
 * генерации (caller завершает турн без повторного результата).
 */
export async function runForcedFinal(inp: ForcedFinalInput): Promise<boolean> {
  const { deps, state, slog, criticGate, auditGate, draft, gateMeta, input, reason } = inp;
  const { config, logger, contextManager } = deps;
  logger.diagnostic("info", `Forcing final answer without tools (${reason})`);
  let finalText = await inp.finalize(draft.onText);
  if (inp.isShutdownRequested()) {
    draft.discard();
    state.stopReason = reason;
    return true;
  }

  const criticStarted = Date.now();
  const action = await criticGate.evaluate({
    state,
    iteration: state.iteration,
    logger,
    contextManager,
    slog,
    task: input,
    planSummary: deps.planSummary?.() ?? undefined,
    planPendingSteps: deps.planPendingSteps?.() ?? undefined,
    toolEvents: gatherTurnToolEvents(contextManager, state.criticHistoryMark),
    beforeFinish: true,
    answerText: finalText,
    onMeta: gateMeta,
  });
  const criticMs = Date.now() - criticStarted;
  slog.logGateTiming({
    iteration: state.iteration,
    total: criticMs,
    gates: { critic: criticMs },
  });
  if (action === "retry") {
    draft.discard();
    finalText = await inp.finalize(draft.onText);
  }

  const auditVerdict = await auditGate.evaluate({
    state,
    iteration: state.iteration,
    maxIterations: config.maxToolIterations,
    logger,
    contextManager,
    slog,
    onMeta: gateMeta,
  });
  if (auditVerdict?.action === "reject") {
    draft.discard();
    finalText = await inp.finalize(draft.onText);
    state.auditFailed = true;
  }
  draft.flush();
  recordFinalAnswer(deps, state, finalText, slog);
  state.stopReason = reason;
  return false;
}
