/**
 * Фабрика начального состояния цикла.
 *
 * Вынесено из `loop-state.ts` (правило 6): состояние цикла — это данные, а
 * фабрика — отдельный модуль, чтобы файл интерфейса не рос.
 */
import type { LoopState } from "./loop-state";
import {
  FORCED_COMPACTION_COOLDOWN,
  RECOVERY_DIRECTIVE_REFRESH,
  RECOVERY_MEMORY_RULE_REFRESH,
} from "./constants";
import { createArtifactChurnState } from "./artifact-progress";

export function createLoopState(): LoopState {
  return {
    iteration: 0,
    lastText: "",
    lastModelText: "",
    lastForcedCompactionIteration: -FORCED_COMPACTION_COOLDOWN,
    lastOverflowCompactionIteration: -1e9,
    lastPendingCompactionIteration: -1e9,
    lastCompactionIteration: -FORCED_COMPACTION_COOLDOWN,
    pendingCompaction: false,
    reactiveCompactionUsed: false,
    hallucinationRetries: 0,
    claimCheckRetries: 0,
    artifactClaimRetries: 0,
    outputClaimRetries: 0,
    webClaimRetries: 0,
    fileCreationRetries: 0,
    lastToolSignature: "",
    consecutiveToolFailures: 0,
    /** Итерация последнего обновления recovery-директивы (троттлинг, §1.6). */
    lastRecoveryDirectiveIteration: -RECOVERY_DIRECTIVE_REFRESH,
    /** Итерация последней записи правила в память об ошибках (§1.6). */
    lastRecoveryMemoryRuleIteration: -RECOVERY_MEMORY_RULE_REFRESH,
    consecutiveFailedBatches: 0,
    honestStopNudged: false,
    consecutiveDuplicateBatches: 0,
    duplicateNudged: false,
    consecutiveResearchBatches: 0,
    researchNudged: false,
    seenToolCalls: new Set<string>(),
    finalizeReason: null,
    stopReason: null,
    consecutiveToolSuccesses: 0,
    repeatedToolCount: 0,
    toolFailureCounts: new Map(),
    memoryRuleRecorded: new Set(),
    disabledTools: new Set(),
    toolDisabledNudged: new Set(),
    toolTargetCounts: new Map(),
    cycleNudgedKeys: new Set(),
    artifactChurn: createArtifactChurnState(),
    sawSecurityBlock: false,
    scriptWorkaroundNudged: false,
    apiPromptTokens: 0,
    apiCompletionTokens: 0,
    apiCompletionChars: 0,
    estimatedPromptTokensTotal: 0,
    totalLlmDuration: 0,
    cacheCachedTotal: 0,
    cacheUncachedTotal: 0,
    cacheWriteTotal: 0,
    cacheSource: "none",
    auditRetries: 0,
    lastAuditSummary: "",
    criticCalls: 0,
    criticRepairCycles: 0,
    mutationsSinceCritic: 0,
    criticHistoryMark: 0,
    seenCriticIssues: new Set(),
    emptyResponseRetries: 0,
    emptyResponseExhausted: false,
    auditFailed: false,
    finalAnswerAccepted: false,
    suppressRepetitionRetry: false,
    llmErrorRetries: 0,
    iterHallucinationRetry: false,
    iterAuditRejection: false,
    iterRecoverableLlmError: false,
    iterPlanCreated: false,
    iterRepetitive: false,
  };
}
