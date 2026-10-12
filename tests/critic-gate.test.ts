import { describe, it, expect, vi } from "vitest";
import { CriticGate, gatherTurnToolEvents, normalizedSignature } from "../src/core/agent/critic-gate";
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

  it("skips chat-only runs without spending the critic budget", async () => {
    const verify = vi.fn(async () => concern);
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify, buildPack: (d: any) => d });
    const d = deps({ toolEvents: [] });
    expect(await gate.evaluate(d)).toBe("pass");
    expect(verify).not.toHaveBeenCalled();
    expect(d.state.criticCalls).toBe(0);
    expect(d.slog.logCritic).not.toHaveBeenCalledWith("critic_check", expect.anything());
  });

  it("returns pass on ok verdict", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => okVerdict, buildPack: (d: any) => d });
    expect(await gate.evaluate(deps())).toBe("pass");
  });

  it("logs a degraded verdict record when the critic returns nothing", async () => {
    // Fail-open, но «critic_check» без следа о вердикте читается как pass.
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => null, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("pass");
    const verdictCall = d.slog.logCritic.mock.calls.find((c: any[]) => c[0] === "critic_verdict");
    expect(verdictCall).toBeDefined();
    expect(verdictCall?.[1]).toMatchObject({ degraded: true, status: "none" });
    expect(d.contextManager.addMessage).not.toHaveBeenCalled();
  });

  it("does not log a degraded record for a real ok verdict", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => okVerdict, buildPack: (d: any) => d });
    const d = deps();
    await gate.evaluate(d);
    const verdictCall = d.slog.logCritic.mock.calls.find((c: any[]) => c[0] === "critic_verdict");
    expect(verdictCall).toBeUndefined();
  });

  it("injects advice without retry on concern", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => concern, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("pass");
    expect(d.contextManager.addMessage).toHaveBeenCalledTimes(1);
    expect(d.state.criticRepairCycles).toBe(0);
  });

  it("passes (no retry) on critical once the repair budget is spent", async () => {
    const second = {
      status: "critical" as const,
      summary: "still broken",
      issues: [{ severity: "critical" as const, claim: "different fresh claim", problem: "p" }],
    };
    const verify = vi.fn(async () => critical);
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("retry");
    verify.mockResolvedValue(second);
    expect(await gate.evaluate(d)).toBe("pass");
    expect(d.state.criticRepairCycles).toBe(1);
    const names = d.slog.logCritic.mock.calls.map((c: any[]) => c[0]);
    expect(names.filter((n: string) => n === "critic_escalation")).toHaveLength(1);
  });

  it("does not spend the repair budget on a near-identical repeat", async () => {
    const first = {
      status: "critical" as const,
      summary: "broken!",
      issues: [{ severity: "critical" as const, claim: "Missing file.", problem: "p" }],
    };
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => first, buildPack: (d: any) => d });
    // Ручной набор: жалоба уже видена (другой кейс), бюджет цел.
    const d = deps();
    d.state.seenCriticIssues.add(
      normalizedSignature({ severity: "critical", claim: "Missing file!", problem: "p" }),
    );
    expect(await gate.evaluate(d)).toBe("pass");
    expect(d.state.criticRepairCycles).toBe(0);
  });

  it("repairs on critical, bounded by maxRepairCycles", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => critical, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("retry");
    expect(await gate.evaluate(d)).toBe("pass"); // repair budget spent -> accept
  });

  it("emits retract on repair so clients drop the streamed draft", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => critical, buildPack: (d: any) => d });
    const onMeta = vi.fn();
    const d = deps({ onMeta });
    expect(await gate.evaluate(d)).toBe("retry");
    expect(onMeta).toHaveBeenCalledWith(expect.any(String), "retract");
  });

  it("diagnoses fail-open verify errors instead of a silent lone critic_check", async () => {
    const verify = vi.fn(async () => {
      throw new Error("boom");
    });
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("pass");
    expect(d.logger.diagnostic).toHaveBeenCalledWith("warn", expect.stringContaining("fail-open"));
  });

  it("dedupes identical issues (second identical verdict adds nothing)", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => concern, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("pass");
    const added = (d.contextManager.addMessage as any).mock.calls.length;
    expect(await gate.evaluate(d)).toBe("pass");
    expect((d.contextManager.addMessage as any).mock.calls.length).toBe(added);
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

describe("gatherTurnToolEvents", () => {
  it("passes arguments and output through (production pack is not blind)", () => {
    const events = gatherTurnToolEvents({
      getActiveHistory: () => [
        { role: "user", content: "do it" },
        { role: "assistant", content: "" },
        {
          role: "tool",
          name: "write_file",
          content: "Written result.txt",
          success: true,
          arguments: { path: "result.txt", content: "HELLO" },
        },
        {
          role: "tool",
          name: "bash",
          content: "1 fail",
          success: false,
          arguments: { command: "bun test" },
        },
      ],
    } as any);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ tool: "write_file", args: { path: "result.txt", content: "HELLO" }, ok: true, output: "Written result.txt" });
    expect(events[1]).toEqual({ tool: "bash", args: { command: "bun test" }, ok: false, output: "1 fail" });
  });

  it("skips non-tool messages and non-string content", () => {
    const events = gatherTurnToolEvents({
      getActiveHistory: () => [
        { role: "assistant", content: "thinking" },
        { role: "tool", content: "orphan without name", success: true },
        { role: "tool", name: "read_file", content: [{ type: "text" }], success: true },
      ],
    } as any);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ tool: "read_file", args: undefined, ok: true, output: undefined });
  });

  it("sees only tool events since the run marker (no leak from previous questions)", () => {
    const history = [
      { role: "user", content: "какая погода в минске?", seq: 0 },
      { role: "tool", name: "web_search", content: "sunny", success: true, arguments: { query: "погода" }, seq: 1 },
      { role: "assistant", content: "Погода хорошая", seq: 2 },
      { role: "user", content: "покажи пример кода react", seq: 3 },
      { role: "assistant", content: "```tsx const a = 1 ```", seq: 4 },
    ];
    const events = gatherTurnToolEvents({ getActiveHistory: () => history } as any, 3);
    expect(events).toHaveLength(0);
  });

  it("keeps current-run tool events after the marker", () => {
    const history = [
      { role: "tool", name: "web_search", content: "old", success: true, seq: 0 },
      { role: "tool", name: "write_file", content: "ok", success: true, arguments: { path: "a.ts" }, seq: 5 },
    ];
    const events = gatherTurnToolEvents({ getActiveHistory: () => history } as any, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ tool: "write_file", args: { path: "a.ts" }, ok: true, output: "ok" });
  });

  it("marker beyond all seqs yields empty; non-positive marker yields all", () => {
    const history = [{ role: "tool", name: "read_file", content: "x", success: true, seq: 0 }];
    expect(gatherTurnToolEvents({ getActiveHistory: () => history } as any, 99)).toHaveLength(0);
    expect(gatherTurnToolEvents({ getActiveHistory: () => history } as any, -5)).toHaveLength(1);
  });
});
