/**
 * Хосты фаз одиночного цикла (`TurnCoordinator`, INV-23): узкие вью одной
 * оболочки `Agent` для loop-setup/пролога/LLM/батча/результата/вывода.
 * Вынесено из `core/agent.ts`; поведение и порядок фаз не меняются.
 */
import type { AgentDeps } from "./deps";
import type { CostTracker } from "../../modules/pricing/index";
import type { PolicyState } from "../../modules/reasoning/policy";
import type { ReasoningState } from "../../tools/set-thinking";
import type { ContextRenderer } from "./context-renderer";
import type { OnMeta, OnPhase } from "../types";
import type { SessionLogger } from "../session-logger";
import type { SystemPromptBuild } from "./prompt-phase";
import type { TurnOutputHost } from "./turn-output";
import type { LoopSetupHost } from "./loop-setup";
import type { LoopResultHost } from "./loop-result";
import type { IterationPrologueHost } from "./iteration-prologue";
import type { LlmPhaseHost } from "./loop-llm";
import type { BatchHost } from "./loop-batch";
import { emitPhase as phaseEmitPhase } from "./turn-output";

/** Общий мутабельный вид `Agent`, из которого строятся хосты фаз. */
export interface AgentHostView {
  deps: AgentDeps;
  costTracker: CostTracker;
  contextRenderer: ContextRenderer;
  policyState: PolicyState;
  reasoningState: ReasoningState;
  probePassed: boolean;
  isShutdownRequested(): boolean;
  getAbortSignal(): AbortSignal | undefined;
  setScope(): void;
  callerProvenance(): { provider: string; model: string };
  buildSystemPrompt(): SystemPromptBuild;
  logContextStat(
    kind: "start" | "iteration",
    iteration: number,
    slog: SessionLogger,
    blocks?: Array<{ label: string; priority: string; tokens: number; included: boolean }>,
  ): void;
  refreshSystemPrompt(): void;
}

/** Хост фазы вывода/финализации. */
export function turnOutputHost(view: AgentHostView): TurnOutputHost {
  return {
    deps: view.deps,
    abortSignal: view.getAbortSignal(),
    isShutdownRequested: () => view.isShutdownRequested(),
  };
}

/** Хост настройки модулей петли. */
export function loopSetupHost(view: AgentHostView): LoopSetupHost {
  return {
    deps: view.deps,
    costTracker: view.costTracker,
    getAbortSignal: () => view.getAbortSignal(),
    isShutdownRequested: () => view.isShutdownRequested(),
    setScope: () => view.setScope(),
    callerProvenance: () => view.callerProvenance(),
  };
}

/** Хост сборки результата петли. */
export function loopResultHost(view: AgentHostView): LoopResultHost {
  return {
    deps: view.deps,
    costTracker: view.costTracker,
    isShutdownRequested: () => view.isShutdownRequested(),
  };
}

/** Хост пролога итерации. */
export function iterationPrologueHost(view: AgentHostView): IterationPrologueHost {
  return {
    deps: view.deps,
    buildSystemPrompt: () => view.buildSystemPrompt(),
    logContextStat: (kind, iteration, slog, blocks) =>
      view.logContextStat(kind, iteration, slog, blocks),
    refreshSystemPrompt: () => view.refreshSystemPrompt(),
  };
}

/** Хост фазы вызова LLM. */
export function llmPhaseHost(view: AgentHostView): LlmPhaseHost {
  return {
    deps: view.deps,
    policyState: view.policyState,
    probePassed: view.probePassed,
    reasoningState: view.reasoningState,
    isShutdownRequested: () => view.isShutdownRequested(),
    getAbortSignal: () => view.getAbortSignal(),
    emitPhase: (iteration, phase, onPhase?: OnPhase, info?) =>
      phaseEmitPhase(turnOutputHost(view), iteration, phase, onPhase, info),
  };
}

/** Хост фазы исполнения батча тулов. */
export function batchHost(view: AgentHostView): BatchHost {
  return {
    deps: view.deps,
    renderContext: (onMeta?: OnMeta) =>
      view.contextRenderer.render(view.deps.config.ui, view.deps.contextManager, onMeta),
  };
}
