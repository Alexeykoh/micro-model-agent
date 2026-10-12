/**
 * Оркестрация одиночного цикла хода (`TurnCoordinator`, INV-23): `while` по
 * итерациям, связывающий пролог → LLM → батч/gейты → финализация. Каждая фаза
 * живёт в своём модуле; здесь — только цикл и передача сигналов.
 *
 * Вынесено из `core/agent.ts`; получает хосты фаз через `LoopRunCtx`.
 */
import type { AgentDeps } from "../agent";
import type { AgentPhase, AgentResult, OnMeta, ToolEvent } from "../types";
import type { ToolDefinition } from "../../tools/types";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";
import type { TokenTracker } from "./token-tracker";
import { createLoopModules, type LoopSetupHost } from "./loop-setup";
import { runIterationPrologue, type IterationPrologueHost } from "./iteration-prologue";
import { runLlmPhase, type LlmPhaseHost } from "./loop-llm";
import { runToolBatchPhase, type BatchHost } from "./loop-batch";
import { runFinalGates } from "./loop-gates";
import { buildLoopResult, type LoopResultHost } from "./loop-result";
import { accumulateToolTargets } from "./loop-nudges";

/** Хосты фаз и доступ к мутабельному состоянию агента. */
export interface LoopRunCtx {
  deps: AgentDeps;
  setIteration(n: number): void;
  isShutdownRequested(): boolean;
  loopSetupHost(): LoopSetupHost;
  iterationPrologueHost(): IterationPrologueHost;
  llmPhaseHost(): LlmPhaseHost;
  batchHost(): BatchHost;
  loopResultHost(): LoopResultHost;
  finalizeWithoutTools(
    state: LoopState,
    tokenTracker: TokenTracker,
    onChunk?: (chunk: string) => void,
    slog?: SessionLogger,
  ): Promise<string>;
}

/** Прогоняет одиночный цикл хода (единственный путь исполнения, INV-22). */
export async function executeAgentLoop(
  ctx: LoopRunCtx,
  input: string,
  slog: SessionLogger,
  onChunk?: (chunk: string) => void,
  onMeta?: OnMeta,
  onTool?: (ev: ToolEvent) => void,
  onPhase?: (phase: AgentPhase) => void,
  onReasoning?: (reasoning: string) => void,
): Promise<AgentResult> {
  const { config, contextManager, logger } = ctx.deps;

  // Модули цикла (состояние + сервисы) — единый контейнер (INV-23).
  const {
    state,
    compactionService,
    tokenTracker,
    reasoningResolver,
    toolBatch,
    hallucinationGate,
    auditGate,
    criticGate,
  } = createLoopModules(ctx.loopSetupHost(), slog);

  while (state.iteration < config.maxToolIterations && !ctx.isShutdownRequested()) {
    state.iteration++;
    ctx.setIteration(state.iteration);
    contextManager.noteIteration();

    // Пролог итерации: тулы/бюджет, компакция, история, монитор префикса (INV-23).
    const { allToolsForBudget, boundedToolNames, history } = runIterationPrologue(
      ctx.iterationPrologueHost(),
      { state, slog, input, onMeta, compactionService },
    );

    const llm = await runLlmPhase(ctx.llmPhaseHost(), {
      state,
      slog,
      input,
      history,
      allToolsForBudget: allToolsForBudget as ToolDefinition[],
      tokenTracker,
      reasoningResolver,
      onChunk,
      onMeta,
      onReasoning,
      onPhase,
    });
    if (llm.kind === "continue") continue;
    if (llm.kind === "break") break;
    if (llm.kind === "return") return llm.result;
    const { textContent, reasoningContent, toolCalls, sawToolCall } = llm;

    const cycleNudges = sawToolCall ? accumulateToolTargets(state, toolCalls) : [];

    if (sawToolCall) {
      const outcome = await runToolBatchPhase(ctx.batchHost(), {
        state,
        toolCalls,
        boundedToolNames,
        textContent,
        reasoningContent,
        input,
        onTool,
        onMeta,
        slog,
        cycleNudges,
        toolBatch,
      });
      if (outcome === "break") break;
      continue;
    }

    const gates = await runFinalGates(ctx.deps, {
      state,
      textContent,
      reasoningContent,
      input,
      slog,
      onChunk,
      onMeta,
      hallucinationGate,
      criticGate,
      auditGate,
    });
    if (gates.kind === "continue") continue;
    if (gates.kind === "break") break;
    if (gates.kind === "return") return gates.result;
    // gates.kind === "ok": гейты пройдены, продолжаем цикл.
  }

  if (
    state.finalizeReason ||
    (state.iteration >= config.maxToolIterations && !state.finalAnswerAccepted)
  ) {
    const reason = state.finalizeReason ?? "max_iters";
    logger.diagnostic("info", `Forcing final answer without tools (${reason})`);
    await ctx.finalizeWithoutTools(state, tokenTracker, onChunk, slog);
    state.stopReason = reason;
  }

  return buildLoopResult(
    ctx.loopResultHost(),
    state,
    tokenTracker,
    state.iteration >= config.maxToolIterations && !state.finalAnswerAccepted,
  );
}
