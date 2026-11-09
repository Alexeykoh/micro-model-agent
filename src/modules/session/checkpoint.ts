/**
 * Чекпоинтер хода (durable state 2/4, спека `2026-11-09-checkpoint-design.md`):
 * сериализация счётчиков `LoopState` в `<sessionDir>/checkpoint.json`.
 *
 * Персистится только прогресс/флаги цикла (не тексты, не история — они уже
 * на диске в `history.jsonl`). Капы множеств/мап ограничивают размер файла.
 */
import type { LoopState } from "../../core/agent/loop-state";

/** Кап входных множеств/мап в снимке (защита от бесконечного роста файла). */
export const CHECKPOINT_KEY_CAP = 500;
export const CHECKPOINT_FAILURE_CAP = 50;
export const CHECKPOINT_TARGET_CAP = 100;
export const CHECKPOINT_ISSUE_CAP = 100;

/** Сериализуемый снимок хода (версия 1). */
export interface TurnCheckpoint {
  v: 1;
  threadId?: string;
  iteration: number;
  pendingCompaction: boolean;
  reactiveCompactionUsed: boolean;
  lastForcedCompactionIteration: number;
  lastOverflowCompactionIteration: number;
  lastPendingCompactionIteration: number;
  lastCompactionIteration: number;
  hallucinationRetries: number;
  claimCheckRetries: number;
  artifactClaimRetries: number;
  outputClaimRetries: number;
  webClaimRetries: number;
  fileCreationRetries: number;
  llmErrorRetries: number;
  truncationRetries: number;
  auditRetries: number;
  criticCalls: number;
  criticRepairCycles: number;
  mutationsSinceCritic: number;
  criticHistoryMark: number;
  lastFinishReason?: string;
  finalAnswerAccepted: boolean;
  consecutiveDuplicateBatches: number;
  duplicateNudged: boolean;
  consecutiveResearchBatches: number;
  researchNudged: boolean;
  consecutiveSilentBatches: number;
  narrationNudged: boolean;
  recentBatchFailures: boolean[];
  failedBatchesTotal: number;
  stallNudged: boolean;
  nonResearchBatchesWithResult: number;
  consecutiveToolFailures: number;
  consecutiveFailedBatches: number;
  honestStopNudged: boolean;
  consecutiveToolSuccesses: number;
  seenToolCalls: string[];
  novelToolKeys: string[];
  disabledTools: string[];
  toolFailureCounts: Record<string, { count: number; error: string; samples: string[] }>;
  memoryRuleRecorded: string[];
  toolTargetCounts: Record<string, number>;
  cycleNudgedKeys: string[];
  consecutiveSingleQuestions: number;
  questionBatchNudged: boolean;
  sawSecurityBlock: boolean;
  scriptWorkaroundNudged: boolean;
  seenCriticIssues: string[];
  emptyResponseRetries: number;
  emptyResponseExhausted: boolean;
  auditFailed: boolean;
  suppressRepetitionRetry: boolean;
}

/** Снимок счётчиков цикла (чистая функция, без IO). */
export function snapshotLoopState(state: LoopState, threadId?: string): TurnCheckpoint {
  return {
    v: 1,
    threadId,
    iteration: state.iteration,
    pendingCompaction: state.pendingCompaction,
    reactiveCompactionUsed: state.reactiveCompactionUsed,
    lastForcedCompactionIteration: state.lastForcedCompactionIteration,
    lastOverflowCompactionIteration: state.lastOverflowCompactionIteration,
    lastPendingCompactionIteration: state.lastPendingCompactionIteration,
    lastCompactionIteration: state.lastCompactionIteration,
    hallucinationRetries: state.hallucinationRetries,
    claimCheckRetries: state.claimCheckRetries,
    artifactClaimRetries: state.artifactClaimRetries,
    outputClaimRetries: state.outputClaimRetries,
    webClaimRetries: state.webClaimRetries,
    fileCreationRetries: state.fileCreationRetries,
    llmErrorRetries: state.llmErrorRetries,
    truncationRetries: state.truncationRetries,
    auditRetries: state.auditRetries,
    criticCalls: state.criticCalls,
    criticRepairCycles: state.criticRepairCycles,
    mutationsSinceCritic: state.mutationsSinceCritic,
    criticHistoryMark: state.criticHistoryMark,
    lastFinishReason: state.lastFinishReason,
    finalAnswerAccepted: state.finalAnswerAccepted,
    consecutiveDuplicateBatches: state.consecutiveDuplicateBatches,
    duplicateNudged: state.duplicateNudged,
    consecutiveResearchBatches: state.consecutiveResearchBatches,
    researchNudged: state.researchNudged,
    consecutiveSilentBatches: state.consecutiveSilentBatches,
    narrationNudged: state.narrationNudged,
    recentBatchFailures: state.recentBatchFailures.slice(),
    failedBatchesTotal: state.failedBatchesTotal,
    stallNudged: state.stallNudged,
    nonResearchBatchesWithResult: state.nonResearchBatchesWithResult,
    consecutiveToolFailures: state.consecutiveToolFailures,
    consecutiveFailedBatches: state.consecutiveFailedBatches,
    honestStopNudged: state.honestStopNudged,
    consecutiveToolSuccesses: state.consecutiveToolSuccesses,
    seenToolCalls: [...state.seenToolCalls].slice(-CHECKPOINT_KEY_CAP),
    novelToolKeys: [...state.novelToolKeys].slice(-CHECKPOINT_KEY_CAP),
    disabledTools: [...state.disabledTools],
    toolFailureCounts: Object.fromEntries(
      [...state.toolFailureCounts.entries()].slice(-CHECKPOINT_FAILURE_CAP),
    ),
    memoryRuleRecorded: [...state.memoryRuleRecorded],
    toolTargetCounts: Object.fromEntries(
      [...state.toolTargetCounts.entries()].slice(-CHECKPOINT_TARGET_CAP),
    ),
    cycleNudgedKeys: [...state.cycleNudgedKeys],
    consecutiveSingleQuestions: state.consecutiveSingleQuestions,
    questionBatchNudged: state.questionBatchNudged,
    sawSecurityBlock: state.sawSecurityBlock,
    scriptWorkaroundNudged: state.scriptWorkaroundNudged,
    seenCriticIssues: [...state.seenCriticIssues].slice(-CHECKPOINT_ISSUE_CAP),
    emptyResponseRetries: state.emptyResponseRetries,
    emptyResponseExhausted: state.emptyResponseExhausted,
    auditFailed: state.auditFailed,
    suppressRepetitionRetry: state.suppressRepetitionRetry,
  };
}

/** Восстановление счётчиков в живой `LoopState` (fail-open на чужих версиях). */
export function restoreLoopState(state: LoopState, snap: TurnCheckpoint): boolean {
  if (snap.v !== 1) return false;
  state.iteration = snap.iteration;
  state.pendingCompaction = snap.pendingCompaction;
  state.reactiveCompactionUsed = snap.reactiveCompactionUsed;
  state.lastForcedCompactionIteration = snap.lastForcedCompactionIteration;
  state.lastOverflowCompactionIteration = snap.lastOverflowCompactionIteration;
  state.lastPendingCompactionIteration = snap.lastPendingCompactionIteration;
  state.lastCompactionIteration = snap.lastCompactionIteration;
  state.hallucinationRetries = snap.hallucinationRetries;
  state.claimCheckRetries = snap.claimCheckRetries;
  state.artifactClaimRetries = snap.artifactClaimRetries;
  state.outputClaimRetries = snap.outputClaimRetries;
  state.webClaimRetries = snap.webClaimRetries;
  state.fileCreationRetries = snap.fileCreationRetries;
  state.llmErrorRetries = snap.llmErrorRetries;
  state.truncationRetries = snap.truncationRetries;
  state.auditRetries = snap.auditRetries;
  state.criticCalls = snap.criticCalls;
  state.criticRepairCycles = snap.criticRepairCycles;
  state.mutationsSinceCritic = snap.mutationsSinceCritic;
  state.criticHistoryMark = snap.criticHistoryMark;
  state.lastFinishReason = snap.lastFinishReason;
  state.finalAnswerAccepted = snap.finalAnswerAccepted;
  state.consecutiveDuplicateBatches = snap.consecutiveDuplicateBatches;
  state.duplicateNudged = snap.duplicateNudged;
  state.consecutiveResearchBatches = snap.consecutiveResearchBatches;
  state.researchNudged = snap.researchNudged;
  state.consecutiveSilentBatches = snap.consecutiveSilentBatches;
  state.narrationNudged = snap.narrationNudged;
  state.recentBatchFailures = snap.recentBatchFailures.slice();
  state.failedBatchesTotal = snap.failedBatchesTotal;
  state.stallNudged = snap.stallNudged;
  state.nonResearchBatchesWithResult = snap.nonResearchBatchesWithResult;
  state.consecutiveToolFailures = snap.consecutiveToolFailures;
  state.consecutiveFailedBatches = snap.consecutiveFailedBatches;
  state.honestStopNudged = snap.honestStopNudged;
  state.consecutiveToolSuccesses = snap.consecutiveToolSuccesses;
  state.seenToolCalls = new Set(snap.seenToolCalls);
  state.novelToolKeys = new Set(snap.novelToolKeys);
  state.disabledTools = new Set(snap.disabledTools);
  state.toolFailureCounts = new Map(Object.entries(snap.toolFailureCounts ?? {}));
  state.memoryRuleRecorded = new Set(snap.memoryRuleRecorded);
  state.toolTargetCounts = new Map(Object.entries(snap.toolTargetCounts ?? {}));
  state.cycleNudgedKeys = new Set(snap.cycleNudgedKeys);
  state.consecutiveSingleQuestions = snap.consecutiveSingleQuestions;
  state.questionBatchNudged = snap.questionBatchNudged;
  state.sawSecurityBlock = snap.sawSecurityBlock;
  state.scriptWorkaroundNudged = snap.scriptWorkaroundNudged;
  state.seenCriticIssues = new Set(snap.seenCriticIssues);
  state.emptyResponseRetries = snap.emptyResponseRetries;
  state.emptyResponseExhausted = snap.emptyResponseExhausted;
  state.auditFailed = snap.auditFailed;
  state.suppressRepetitionRetry = snap.suppressRepetitionRetry;
  return true;
}

/** Парсинг сырой строки checkpoint.json (битый JSON/версия → null, fail-open). */
export function parseTurnCheckpoint(raw: string): TurnCheckpoint | null {
  try {
    const parsed = JSON.parse(raw) as TurnCheckpoint;
    if (parsed?.v !== 1 || typeof parsed.iteration !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}
