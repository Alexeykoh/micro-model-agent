import { describe, it, expect } from "vitest";
import { ReasoningEffortResolver } from "../../src/core/agent/reasoning-resolver";
import { createPolicyState } from "../../src/modules/reasoning/policy";
import { createLoopState } from "../../src/core/agent/loop-state";
import type { ReasoningConfig } from "../../src/config/types";

function config(mode: ReasoningConfig["mode"] = "auto"): ReasoningConfig {
  return {
    mode,
    min: "low",
    max: "xhigh",
    baseline: "low",
    overrideCooldown: 0,
  };
}

function base(overrides: Record<string, unknown> = {}) {
  const state = createLoopState();
  state.iteration = 1;
  return {
    state,
    policyState: createPolicyState(),
    reasoningConfig: config(),
    probePassed: true,
    reasoningStrategy: "openai-effort" as const,
    reasoningLevels: ["low", "medium", "xhigh"],
    reasoningState: { level: "low" as const, overrideIteration: -1, manual: false },
    ...overrides,
  };
}

describe("ReasoningEffortResolver native levels", () => {
  it("auto raise lands on the server's max name (xhigh), not canonical high", () => {
    const resolver = new ReasoningEffortResolver();
    const args = base();
    args.state.iterHallucinationRetry = true;
    const res = resolver.resolve(args as never);
    expect(res.level).toBe("xhigh");
    expect(res.source).toBe("policy");
  });

  it("auto baseline stays on the declared low", () => {
    const resolver = new ReasoningEffortResolver();
    const res = resolver.resolve(base() as never);
    expect(res.level).toBe("low");
    expect(res.source).toBe("policy");
  });

  it("empty declared set disables the policy (no granular effort)", () => {
    const resolver = new ReasoningEffortResolver();
    const args = base({ reasoningLevels: [] });
    args.state.iterHallucinationRetry = true;
    const res = resolver.resolve(args as never);
    expect(res.level).toBeUndefined();
  });

  it("fixed mode xhigh passes through unchanged", () => {
    const resolver = new ReasoningEffortResolver();
    const res = resolver.resolve(base({ reasoningConfig: config("xhigh") }) as never);
    expect(res.level).toBe("xhigh");
    expect(res.source).toBe("fixed");
  });
});
