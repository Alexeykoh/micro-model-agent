/**
 * RCV-9: failure-based терминалы петли не должны обрывать решаемую задачу.
 * Вместо tool-less финала харнесс отдаёт ошибку recovery-сабагенту, сбрасывает
 * стрики и продолжает ход — маленькие модели часто путаются, но могут доделать.
 */
import type { StopReason } from "../../core/types";
import type { LoopState } from "../../core/api";

/** Причины, которые означают «застрял», а не «давай финальный ответ». */
export const RECOVERABLE_TERMINALS = new Set<StopReason>([
  "failed_batches",
  "stalled",
  "duplicate",
  "silent",
]);

export function isRecoverableTerminal(reason: StopReason): boolean {
  return RECOVERABLE_TERMINALS.has(reason);
}

/**
 * Сброс стриков после успешного recovery: иначе следующий же батч снова
 * наберёт порог и терминал сработает немедленно. Не трогаем счётчики токенов,
 * итераций и принятых ответов.
 */
export function resetFailureCounters(state: LoopState): void {
  state.consecutiveToolFailures = 0;
  state.consecutiveToolSuccesses = 0;
  state.consecutiveFailedBatches = 0;
  state.consecutiveDuplicateBatches = 0;
  state.consecutiveSilentBatches = 0;
  state.failedBatchesTotal = 0;
  state.recentBatchFailures.length = 0;
  state.honestStopNudged = false;
  state.duplicateNudged = false;
  state.narrationNudged = false;
  state.stallNudged = false;
  state.researchNudged = false;
  state.toolFailureCounts.clear();
}
