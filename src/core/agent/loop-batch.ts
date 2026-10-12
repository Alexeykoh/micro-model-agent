/**
 * Фаза исполнения пакета тулов (`TurnCoordinator`, INV-23): прогон `ToolBatch`,
 * нуджи после него и рендер контекст-индикаторов. Вынесено из `core/agent.ts`.
 *
 * Возвращает сигнал петли: `continue` (тулы продолжили работу → следующая
 * итерация, минуя финальные гейты) или `break` (финализация/прерывание).
 */
import type { AgentDeps } from "../agent";
import type { OnMeta } from "../types";
import type { ToolCall } from "../../tools/types";
import type { LoopState } from "./loop-state";
import type { ToolBatchExecutor } from "./tool-batch";
import type { SessionLogger } from "../session-logger";
import { applyBatchNudges } from "./loop-nudges";

/** Мутабельный вид `Agent`, которым владеет фаза батча. */
export interface BatchHost {
  deps: AgentDeps;
  renderContext(onMeta?: OnMeta): void;
}

/** Входные данные фазы батча на итерации. */
export interface BatchInput {
  state: LoopState;
  toolCalls: ToolCall[];
  boundedToolNames: Set<string>;
  textContent: string;
  reasoningContent: string;
  input: string;
  onTool?: (ev: import("../types").ToolEvent) => void;
  onMeta?: OnMeta;
  slog: SessionLogger;
  cycleNudges: string[];
  toolBatch: ToolBatchExecutor;
}

/** Исполняет батч тулов и возвращает сигнал петли. */
export async function runToolBatchPhase(
  host: BatchHost,
  inp: BatchInput,
): Promise<"continue" | "break"> {
  const { deps } = host;
  const { state, toolCalls, boundedToolNames, textContent, reasoningContent, input, slog } = inp;
  const { onTool, onMeta, cycleNudges, toolBatch } = inp;

  const batch = await toolBatch.execute(
    state,
    toolCalls,
    boundedToolNames,
    textContent,
    reasoningContent,
    input,
    onTool,
    onMeta,
    slog,
  );
  if (batch.finalize) {
    state.finalizeReason = batch.finalize;
    return "break";
  }
  if (batch.interrupted) return "break";

  applyBatchNudges(state, cycleNudges, {
    logger: deps.logger,
    contextManager: deps.contextManager,
  });

  host.renderContext(onMeta);

  // Тулы означают, что модель продолжила работать, а не переотвечает —
  // послабление на повтор после аудита больше не действует.
  state.suppressRepetitionRetry = false;
  return "continue";
}
