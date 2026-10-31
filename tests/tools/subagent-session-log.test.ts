/**
 * Журнал прогона субагента в `session.jsonl` (спека
 * `2026-10-27-subagent-run-journal-design`).
 *
 * До правки между `subagent` call и result в `ses_mvoac9q9` было 283 секунды и
 * ноль событий: ни тулов, ни usage, ни причины падения.
 */
import { describe, it, expect } from "vitest";
import { subagentLogEntry } from "../../src/tools/subagent-session-log";
import { emitSubagentEvent, type SubagentRunEvent } from "../../src/tools/subagent-runs";
import { createSubagentObserver } from "../../src/tools/subagent-observer";
import { TokenTracker } from "../../src/core/agent/token-tracker";
import { createLoopState } from "../../src/core/agent/loop-state";

const RUN = "srun_test123";

function startEvent(overrides: Partial<Extract<SubagentRunEvent, { kind: "start" }>> = {}) {
  return {
    kind: "start" as const,
    runId: RUN,
    depth: 1,
    task: "прочитай src/App.tsx и верни отчёт",
    agent: "code",
    model: "test-model",
    at: 1,
    ...overrides,
  };
}

describe("subagent session log", () => {
  it("writes start with depth, expert and a one-line task", () => {
    const entry = subagentLogEntry(startEvent({ task: "a".repeat(400) }))!;
    expect(entry.type).toBe("subagent");
    expect(entry.source).toBe("core");
    expect(entry.subagent).toBe(RUN);
    expect(entry.content).toBe("start");
    expect(entry.status).toBe("running");
    expect(entry.tool!.length).toBeLessThanOrEqual(120);
    expect(entry.args).toMatchObject({ depth: 1, agent: "code", model: "test-model" });
  });

  it("writes a tool result with a clipped output head", () => {
    const entry = subagentLogEntry({
      kind: "tool_end",
      runId: RUN,
      callId: "c1",
      tool: "read_file",
      success: true,
      durationMs: 12,
      output: "x".repeat(1000),
    })!;
    expect(entry.content).toBe("tool");
    expect(entry.tool).toBe("read_file");
    expect(entry.success).toBe(true);
    expect(entry.duration).toBe(12);
    expect(entry.summary!.length).toBeLessThanOrEqual(200);
  });

  it("writes per-call usage with origin", () => {
    const entry = subagentLogEntry({
      kind: "llm_usage",
      runId: RUN,
      iteration: 3,
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
      origin: "api",
      durationMs: 900,
    })!;
    expect(entry.content).toBe("usage");
    expect(entry.origin).toBe("api");
    expect(entry.promptTokens).toBe(1000);
    expect(entry.iteration).toBe(3);
  });

  it("writes the end status, iterations and clipped error", () => {
    const entry = subagentLogEntry({
      kind: "end",
      runId: RUN,
      status: "failed",
      iterations: 4,
      durationMs: 5000,
      error: "e".repeat(900),
    })!;
    expect(entry.content).toBe("end");
    expect(entry.status).toBe("failed");
    expect(entry.success).toBe(false);
    expect(entry.iteration).toBe(4);
    expect(entry.summary!.length).toBeLessThanOrEqual(300);
  });

  it("does not journal text, reasoning, notes or phases", () => {
    const skipped: SubagentRunEvent[] = [
      { kind: "text", runId: RUN, chunk: "hi" },
      { kind: "reasoning", runId: RUN, chunk: "think" },
      { kind: "note", runId: RUN, chunk: "status" },
      { kind: "phase", runId: RUN, phase: "thinking" },
      { kind: "tool_start", runId: RUN, callId: "c1", tool: "read_file", args: {} },
    ];
    for (const event of skipped) expect(subagentLogEntry(event)).toBeUndefined();
  });

  it("forwards events to the session log and survives a broken web sink", () => {
    const logged: SubagentRunEvent[] = [];
    emitSubagentEvent(
      {
        subagentRuns: {
          emit: () => {
            throw new Error("web sink упал");
          },
        },
        subagentLog: (e) => logged.push(e),
      },
      startEvent(),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0].kind).toBe("start");
  });

  it("emits usage through the observer", () => {
    const logged: SubagentRunEvent[] = [];
    const observer = createSubagentObserver({ sessionId: "ses_x", subagentLog: (e) => logged.push(e) }, {
      task: "t",
      depth: 1,
    });
    observer.start();
    observer.callbacks.onUsage({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      origin: "estimate",
    });
    const usage = logged.find((e) => e.kind === "llm_usage");
    expect(usage).toMatchObject({ runId: observer.runId, origin: "estimate", totalTokens: 15 });
  });

  it("TokenTracker reports per-call usage with the real origin", () => {
    const seen: Array<{ origin?: string; totalTokens: number }> = [];
    const state = createLoopState();
    const tracker = new TokenTracker(
      { record: () => {}, recordActual: () => {} } as never,
      () => ({ provider: "p", model: "m" }),
      (u) => seen.push({ origin: u.origin, totalTokens: u.totalTokens }),
    );
    const baseline = tracker.beginIteration(state, 500);
    tracker.logUsage(state, baseline, "ответ", 500, 1, 10, 5, {
      logLlmUsage: () => {},
    } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe("estimate");
    expect(seen[0].totalTokens).toBeGreaterThan(0);
  });
});
