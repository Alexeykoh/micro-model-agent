import { describe, it, expect, vi } from "vitest";
import { CriticGate, gatherTurnToolEvents } from "../src/core/agent/critic-gate";
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
      { role: "user", content: "какая погода в минске?" },
      { role: "tool", name: "web_search", content: "sunny", success: true, arguments: { query: "погода" } },
      { role: "assistant", content: "Погода хорошая" },
      { role: "user", content: "покажи пример кода react" },
      { role: "assistant", content: "```tsx const a = 1 ```" },
    ];
    const events = gatherTurnToolEvents({ getActiveHistory: () => history } as any, 4);
    expect(events).toHaveLength(0);
  });

  it("keeps current-run tool events after the marker", () => {
    const history = [
      { role: "tool", name: "web_search", content: "old", success: true },
      { role: "tool", name: "write_file", content: "ok", success: true, arguments: { path: "a.ts" } },
    ];
    const events = gatherTurnToolEvents({ getActiveHistory: () => history } as any, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ tool: "write_file", args: { path: "a.ts" }, ok: true, output: "ok" });
  });

  it("clamps an out-of-range marker (e.g. history compacted mid-run) to empty", () => {
    const history = [{ role: "tool", name: "read_file", content: "x", success: true }];
    expect(gatherTurnToolEvents({ getActiveHistory: () => history } as any, 99)).toHaveLength(0);
    expect(gatherTurnToolEvents({ getActiveHistory: () => history } as any, -5)).toHaveLength(1);
  });
});
