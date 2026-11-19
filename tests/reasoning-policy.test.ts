import { describe, it, expect } from "vitest";
import { evaluateReasoningPolicy, createPolicyState } from "../src/modules/reasoning/policy";
import type { PolicyInput } from "../src/modules/reasoning/policy";

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    hallucinationRetry: false,
    auditRejection: false,
    recoverableLlmError: false,
    planCreated: false,
    consecutiveSuccesses: 0,
    isRepetitive: false,
    baseline: "low",
    ...overrides,
  };
}

describe("reasoning policy", () => {
  it("raises effort on repetitive tool loops (stuck, not routine)", () => {
    const res = evaluateReasoningPolicy(input({ isRepetitive: true }), createPolicyState());
    expect(res.level).toBe("high");
    expect(res.reason).toBe("policy:repetitive-tools");
  });

  it("lowers effort on routine consecutive successes", () => {
    const res = evaluateReasoningPolicy(input({ consecutiveSuccesses: 2 }), createPolicyState());
    expect(res.level).toBe("low");
    expect(res.reason).toBe("policy:routine-write");
  });

  it("raises to high on a hallucination retry", () => {
    const res = evaluateReasoningPolicy(input({ hallucinationRetry: true }), createPolicyState());
    expect(res.level).toBe("high");
    expect(res.reason).toBe("policy:hallucination-retry");
  });
});
