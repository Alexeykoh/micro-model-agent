// LM-1/2: fixed-режим не отправляет неподдерживаемый уровень рассуждений.
import { describe, it, expect } from "vitest";
import { negotiateReasoningLevel } from "../../src/core/agent/reasoning-negotiation";
import { ReasoningEffortResolver } from "../../src/core/agent/reasoning-resolver";
import { createLoopState } from "../../src/core/agent/loop-state";
import { DIAGNOSTIC_EVENTS } from "../../src/output/types";

it("registers reasoning_degraded as an observable fail-open signal", () => {
  expect(DIAGNOSTIC_EVENTS).toContain("reasoning_degraded");
});

const deps = () => ({
  state: createLoopState(),
  policyState: { level: "low" } as never,
  reasoningConfig: { mode: "minimal" as const },
  probePassed: false,
  reasoningStrategy: undefined,
  reasoningLevels: undefined,
  reasoningState: { manual: false, level: "low", overrideIteration: -1 } as never,
});

describe("reasoning negotiation", () => {
  it("drops fixed level when the mechanism probe failed", () => {
    const r = negotiateReasoningLevel("minimal", false, undefined);
    expect(r.level).toBeUndefined();
    expect(r.cause).toBe("mechanism ignored");
  });

  it("drops fixed level when no granular levels are declared", () => {
    const r = negotiateReasoningLevel("minimal", true, []);
    expect(r.level).toBeUndefined();
    expect(r.cause).toBe("no granular levels");
  });

  it("keeps level when probe passed and levels exist", () => {
    expect(negotiateReasoningLevel("low", true, ["low", "high"]).level).toBe("low");
  });

  it("resolver applies the same clamp in fixed mode", () => {
    const result = new ReasoningEffortResolver().resolve(deps());
    expect(result.level).toBeUndefined();
    expect(result.source).toBe("fixed");

    const ok = new ReasoningEffortResolver().resolve({ ...deps(), probePassed: true, reasoningLevels: ["low"] });
    expect(ok.level).toBe("minimal");
  });
});
