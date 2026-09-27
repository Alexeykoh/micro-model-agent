import { describe, it, expect, vi } from "vitest";
import { CriticGate } from "../src/core/agent/critic-gate";
import { createLoopState } from "../src/core/agent/loop-state";

function deps(overrides: Partial<any> = {}) {
  const state = createLoopState();
  state.mutationsSinceCritic = 3;
  return {
    state,
    iteration: 5,
    logger: { warn: vi.fn(), info: vi.fn(), diagnostic: vi.fn() } as any,
    contextManager: { addMessage: vi.fn() } as any,
    slog: { logCritic: vi.fn() } as any,
    task: "do it",
    beforeFinish: true,
    toolEvents: [{ tool: "write_file", args: { path: "a" }, ok: true }],
    ...overrides,
  };
}

const okVerdict = { status: "ok" as const, summary: "", issues: [] };
const concern = { status: "concern" as const, summary: "gap", issues: [{ severity: "concern" as const, claim: "c", problem: "p" }] };
const critical = { status: "critical" as const, summary: "broken", issues: [{ severity: "critical" as const, claim: "c", problem: "p" }] };

describe("CriticGate", () => {
  it("skips when disabled or no mutations", async () => {
    const verify = vi.fn();
    const gate = new CriticGate({ enabled: false, maxCalls: 4, maxRepairCycles: 1, verify, buildPack: (d: any) => d });
    expect(await gate.evaluate(deps())).toBe("pass");
    expect(verify).not.toHaveBeenCalled();
  });

  it("returns pass on ok verdict", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => okVerdict, buildPack: (d: any) => d });
    expect(await gate.evaluate(deps())).toBe("pass");
  });

  it("injects advice and retries on concern", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => concern, buildPack: (d: any) => d });
    expect(await gate.evaluate(deps())).toBe("retry");
  });

  it("repairs on critical, bounded by maxRepairCycles", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => critical, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("retry");
    expect(await gate.evaluate(d)).toBe("pass"); // repair budget spent -> accept
  });

  it("dedupes identical issues", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => concern, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("retry");
    expect(await gate.evaluate(d)).toBe("pass");
  });

  it("stops after maxCalls", async () => {
    const verify = vi.fn(async () => concern);
    const gate = new CriticGate({ enabled: true, maxCalls: 1, maxRepairCycles: 1, verify, buildPack: (d: any) => d });
    const d = deps();
    await gate.evaluate(d);
    expect(await gate.evaluate(d)).toBe("pass");
  });

  it("logs critic_check whenever a check actually runs", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => okVerdict, buildPack: (d: any) => d });
    const d = deps();
    await gate.evaluate(d);
    expect(d.slog.logCritic).toHaveBeenCalledWith("critic_check", expect.objectContaining({ beforeFinish: true, mutations: 3 }));
  });

  it("logs one critic_verdict entry per non-ok verdict and keeps it out of the chat", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => critical, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("retry");
    const names = d.slog.logCritic.mock.calls.map((c: any[]) => c[0]);
    expect(names).toEqual(["critic_check", "critic_verdict", "critic_escalation"]);
    expect(d.slog.logCritic).toHaveBeenCalledWith(
      "critic_verdict",
      expect.objectContaining({ status: "critical", issueCount: 1, summary: "broken" }),
    );
    expect(d.logger.diagnostic).toHaveBeenCalledWith("info", expect.stringContaining("Critic critical: broken"));
  });

  it("does not log a verdict (or diagnostic line) for ok verdicts", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => okVerdict, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("pass");
    const names = d.slog.logCritic.mock.calls.map((c: any[]) => c[0]);
    expect(names).toEqual(["critic_check"]);
    expect(d.logger.diagnostic).not.toHaveBeenCalled();
  });
});
