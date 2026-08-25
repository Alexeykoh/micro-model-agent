// src/modules/reasoning/policy.ts
import type { ReasoningLevel } from "../../config/types";

export interface PolicyInput {
  /** Hallucination-retry triggered this iteration. */
  hallucinationRetry: boolean;
  /** Final-audit rejection triggered this iteration. */
  auditRejection: boolean;
  /** Recoverable LLM error triggered this iteration. */
  recoverableLlmError: boolean;
  /** Plan was created or re-planned this iteration. */
  planCreated: boolean;
  /** Consecutive successful file-mutating calls on the current step. */
  consecutiveSuccesses: number;
  /** Stuck detector reports repetitive tool calls. */
  isRepetitive: boolean;
  /** Baseline level from config (the default level). */
  baseline: ReasoningLevel;
}

export interface PolicyResult {
  level: ReasoningLevel;
  reason: string;
}

export interface PolicyState {
  /** Iterations since the last raise event. */
  iterationsSinceRaise: number;
  /** If >0, boost level for this many iterations (plan created). */
  boostRemaining: number;
}

export function createPolicyState(): PolicyState {
  return { iterationsSinceRaise: 0, boostRemaining: 0 };
}

const DECAY_THRESHOLD = 5;

export function evaluateReasoningPolicy(
  input: PolicyInput,
  state: PolicyState,
): PolicyResult {
  // Raise signals (highest priority)
  if (input.hallucinationRetry || input.auditRejection || input.recoverableLlmError) {
    state.iterationsSinceRaise = 0;
    return { level: "high", reason: input.hallucinationRetry ? "policy:hallucination-retry" : input.auditRejection ? "policy:audit-rejection" : "policy:recoverable-llm-error" };
  }

  // Plan created → boost for N iterations
  if (input.planCreated) {
    state.boostRemaining = 3;
    state.iterationsSinceRaise = 0;
    return { level: "high", reason: "policy:plan-created" };
  }

  // Active boost from plan creation
  if (state.boostRemaining > 0) {
    state.boostRemaining--;
    state.iterationsSinceRaise = 0;
    return { level: "high", reason: "policy:plan-boost" };
  }

  // Lower signals
  if (input.consecutiveSuccesses >= 2) {
    state.iterationsSinceRaise++;
    return { level: "low", reason: "policy:routine-write" };
  }

  if (input.isRepetitive) {
    state.iterationsSinceRaise++;
    return { level: "low", reason: "policy:repetitive-tools" };
  }

  // Decay: if raised for too long, return to baseline
  if (state.iterationsSinceRaise >= DECAY_THRESHOLD) {
    state.iterationsSinceRaise = 0;
    return { level: input.baseline, reason: "policy:decay" };
  }

  // Default: baseline
  state.iterationsSinceRaise++;
  return { level: input.baseline, reason: "policy:default" };
}
