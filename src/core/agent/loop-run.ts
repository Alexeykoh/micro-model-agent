/**
 * Оркестрация одиночного цикла хода (`TurnCoordinator`, INV-23): `while` по
 * итерациям, связывающий пролог → LLM → батч/gейты → финализация. Каждая фаза
 * живёт в своём модуле; здесь — только цикл и передача сигналов.
 *
 * Вынесено из `core/agent.ts`; получает хосты фаз через `LoopRunCtx`.
 */
import type { AgentDeps } from "../agent";
import type { AgentResult, OnMeta, OnPhase, ToolEvent } from "../types";
import type { ToolDefinition } from "../../tools/types";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";
import type { TokenTracker } from "./token-tracker";
import { createLoopModules, type LoopSetupHost } from "./loop-setup";
import { runIterationPrologue, type IterationPrologueHost } from "./iteration-prologue";
import { runLlmPhase, type LlmPhaseHost } from "./loop-llm";
import { runToolBatchPhase, type BatchHost } from "./loop-batch";
import { runFinalGates, type GateTimings } from "./loop-gates";
import { gatherTurnToolEvents } from "./critic-events";
import { buildLoopResult, type LoopResultHost } from "./loop-result";
import { snapshotLoopState } from "../../modules/session/checkpoint";
import { getOtelAdapter } from "../../modules/otel/adapter";
import { costBudgetExceeded } from "./cost-budget";
import { accumulateToolTargets } from "./loop-nudges";

/** Хосты фаз и доступ к мутабельному состоянию агента. */
export interface LoopRunCtx {
  deps: AgentDeps;
  setIteration(n: number): void;
  isShutdownRequested(): boolean;
  /** Гейт паузы на границе итераций (INV-P1, спека webui-pause-resume). */
  waitWhilePaused(): Promise<void>;
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
  onPhase?: OnPhase,
  onReasoning?: (reasoning: string) => void,
): Promise<AgentResult> {
  const { config, contextManager, logger } = ctx.deps;

  // Новый ход: условия директив харнесса обнулены (стрики — per-turn), поэтому
  // стоящие директивы прошлого хода снимаются. Внутри хода они переживают
  // компакцию (см. `ContextManager.standingDirectives`).
  contextManager.standingDirectives?.clear();

  // OTel workflow-span (P0, 1/2): связка thread/session; no-op при выключенности.
  const otel = getOtelAdapter();
  const activeMetaForOtel = ctx.deps.sessionManager?.getActiveMeta?.() ?? null;
  if (activeMetaForOtel) {
    otel.setThread(activeMetaForOtel.threadId, activeMetaForOtel.id);
  }
  const agentSpan = otel.startSpan("agent.run", {
    "gen_ai.system": "mma",
    "gen_ai.agent.name": "mma-agent",
  });
  const finishSpan = async (result: AgentResult): Promise<AgentResult> => {
    await agentSpan.ended("ok", {});
    return result;
  };

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

  // Всё, что харнесс вставляет модели в контекст (директивы, recovery-гайданс,
  // статус плана), пишется в журнал сессии событием `directive`: иначе при
  // разборе видно только действия агента, но не то, что ему было сказано.
  // `?.` — тестовые дубли ContextManager не обязаны реализовывать приёмник
  // журнала (см. tests/arch/double-honesty.test.ts); в проде класс свой.
  contextManager.setHarnessSink?.((text) =>
    slog.logDirective("system_summary", text, state.iteration),
  );

  while (state.iteration < config.maxToolIterations && !ctx.isShutdownRequested()) {
    // INV-P1: пауза разворачивается только здесь, на границе итераций —
    // LLM-стрим и батч тулов не разрезаются. После выхода из ожидания
    // перечитываем shutdown: стоп будит гейт (INV-P3), цикл обязан выйти.
    await ctx.waitWhilePaused();
    if (ctx.isShutdownRequested()) break;
    // Глобальный kill-switch (HITL): мгновенный стоп хода на границе
    // итерации (текущий LLM-вызов/батч доходят до конца).
    if (config.hitl?.killSwitch) {
      logger.diagnostic("warn", "hitl kill-switch: turn stopped");
      break;
    }
    state.iteration++;
    ctx.setIteration(state.iteration);
    contextManager.noteIteration();

    // Пролог итерации: тулы/бюджет, компакция, история, монитор префикса (INV-23).
    const { allToolsForBudget, boundedToolNames, history } = await runIterationPrologue(
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
    if (llm.kind === "return") return finishSpan(llm.result);

    // Cost/LLM-gateway MVP: per-run бюджет. Превышение — форс-финал
    // (`stopReason=cost_budget` + critic), как для max_iters.
    const maxRunUsd = ctx.deps.config.cost?.maxRunUsd ?? 0;
    if (costBudgetExceeded(state.apiCostUsd, maxRunUsd)) {
      state.finalizeReason = "cost_budget";
      break;
    }
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
      // Durable checkpoint (2/4): снимок на границе батча — краш между ходами
      // продолжает с того же состояния. Синхронная запись, fail-open.
      const activeMeta = ctx.deps.sessionManager?.getActiveMeta?.() ?? null;
      if (activeMeta?.id) {
        try {
          ctx.deps.sessionManager?.saveCheckpoint?.(
            activeMeta.id,
            snapshotLoopState(state, activeMeta.threadId),
          );
        } catch (err) {
          logger.diagnostic("warn", `checkpoint save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      continue;
    }

    const timings: GateTimings = {};
    const gatesStarted = Date.now();
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
      timings,
      isShutdownRequested: () => ctx.isShutdownRequested(),
    });
    // Агрегат простоя хода в гейтах (A15): одна запись на проход — по ней видно,
    // где именно уходят секунды после уже доставленного ответа.
    slog.logGateTiming({
      iteration: state.iteration,
      total: Date.now() - gatesStarted,
      gates: timings,
    });
    if (gates.kind === "continue") continue;
    if (gates.kind === "break") break;
    if (gates.kind === "return") return finishSpan(gates.result);
    // gates.kind === "ok": гейты пройдены, продолжаем цикл.
  }

  if (
    state.finalizeReason ||
    (state.iteration >= config.maxToolIterations && !state.finalAnswerAccepted)
  ) {
    const reason = state.finalizeReason ?? "max_iters";
    logger.diagnostic("info", `Forcing final answer without tools (${reason})`);
    const text = await ctx.finalizeWithoutTools(state, tokenTracker, onChunk, slog);
    // INV-C7: форс-финал тоже проходит через критика. Иначе самый длинный
    // (и самый рискованный) ход остаётся единственным непроверенным.
    const forcedCriticStarted = Date.now();
    // Прерванный ход не проверяем: пользователь уже остановил работу.
    if (ctx.isShutdownRequested()) {
      state.stopReason = reason;
      return finishSpan(buildLoopResult(
        ctx.loopResultHost(),
        state,
        tokenTracker,
        state.iteration >= config.maxToolIterations && !state.finalAnswerAccepted,
      ));
    }
    const action = await criticGate.evaluate({
      state,
      iteration: state.iteration,
      logger,
      contextManager,
      slog,
      task: input,
      planSummary: ctx.deps.planSummary?.() ?? undefined,
      planPendingSteps: ctx.deps.planPendingSteps?.() ?? undefined,
      toolEvents: gatherTurnToolEvents(contextManager, state.criticHistoryMark),
      beforeFinish: true,
      answerText: text,
      onMeta,
    });
    const forcedCriticMs = Date.now() - forcedCriticStarted;
    slog.logGateTiming({
      iteration: state.iteration,
      total: forcedCriticMs,
      gates: { critic: forcedCriticMs },
    });
    if (action === "retry") {
      // Критик потребовал починки: один форс-вызов с его требованием.
      await ctx.finalizeWithoutTools(state, tokenTracker, onChunk, slog);
    }
    // S6: детерминированный аудит на форс-финале. Критик — LLM-гейт, он может
    // таймаутнуть; без аудита самый рискованный ход остаётся единственным
    // непроверенным. `exhausted` сам взводит `auditFailed`.
    const auditVerdict = await auditGate.evaluate({
      state,
      iteration: state.iteration,
      maxIterations: config.maxToolIterations,
      logger,
      contextManager,
      slog,
      onMeta,
    });
    if (auditVerdict?.action === "reject") {
      // Аудит отклонил ответ: один форс-вызов с его требованием. Бюджет гейтов
      // уже потрачен, поэтому прогон завершается честным провалом, а не
      // «успехом» с незакрытым планом.
      await ctx.finalizeWithoutTools(state, tokenTracker, onChunk, slog);
      state.auditFailed = true;
    }
    state.stopReason = reason;
  }

  return finishSpan(buildLoopResult(
    ctx.loopResultHost(),
    state,
    tokenTracker,
    state.iteration >= config.maxToolIterations && !state.finalAnswerAccepted,
  ));
}
