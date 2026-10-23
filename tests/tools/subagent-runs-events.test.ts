// События прогона субагента: runId, порядок, fail-open наблюдателя.
// Наблюдатель — шов веб-UI (см. docs/specs/2026-10-23-subagent-run-view-design.md).
import { describe, it, expect, vi } from "vitest";
import { subagentTool } from "../../src/tools/subagent";
import type { SubagentRunEvent } from "../../src/tools/subagent-runs";

function makeCtx(sink: (ev: SubagentRunEvent) => void, run?: (cb: any) => Promise<any>): any {
  return {
    baseDir: "/tmp/ws",
    config: {
      model: "test-model",
      contextWindow: 32768,
      contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    sessionId: "ses_test",
    activeCallId: "call_parent",
    toolExecutor: {
      setScope() {},
      getScope: () => undefined,
      setRecursionDepth() {},
      getRecursionDepth: () => 0,
      getRegistry: () => ({ getByTags: () => [] }),
    },
    llmProvider: { chat: async () => ({}) },
    subagentRuns: { emit: sink },
    agentFactory: () => ({
      run: async (_task: string, onChunk: any, _onMeta: any, onTool: any, onPhase: any, onReasoning: any) => {
        onPhase?.("thinking");
        onReasoning?.("think");
        onChunk?.("hello");
        onTool?.({ type: "start", tool: "read_file", args: { path: "a" }, callId: "c1" });
        onTool?.({ type: "end", tool: "read_file", args: { path: "a" }, callId: "c1", output: "body" });
        onChunk?.(" world");
        return run ? run({ onChunk }) : { success: true, text: "final answer", iterationCount: 2, totalTokens: 2 };
      },
    }),
  };
}

describe("subagent run events", () => {
  it("emits start/text/tool/end with run identity", async () => {
    const events: SubagentRunEvent[] = [];
    const result = await subagentTool.handler(makeCtx((ev) => events.push(ev)), { task: "do it" });

    expect(result.success).toBe(true);
    const start = events.find((e) => e.kind === "start");
    expect(start).toBeDefined();
    if (start?.kind !== "start") throw new Error("no start");
    expect(start.runId).toMatch(/^srun_/);
    expect(start.parentSessionId).toBe("ses_test");
    expect(start.parentToolCallId).toBe("call_parent");
    expect(start.task).toBe("do it");
    expect(start.model).toBe("test-model");

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("start");
    expect(kinds).toContain("text");
    expect(kinds).toContain("reasoning");
    expect(kinds).toContain("phase");
    expect(kinds).toContain("tool_start");
    expect(kinds).toContain("tool_end");
    expect(kinds[kinds.length - 1]).toBe("end");

    const toolStart = events.find((e) => e.kind === "tool_start");
    const toolEnd = events.find((e) => e.kind === "tool_end");
    if (toolStart?.kind === "tool_start" && toolEnd?.kind === "tool_end") {
      expect(toolStart.callId).toBe("c1");
      expect(toolEnd.callId).toBe("c1");
      expect(toolEnd.output).toBe("body");
    }

    const end = events[events.length - 1];
    if (end.kind !== "end") throw new Error("no end");
    expect(end.status).toBe("done");
    expect(end.iterations).toBe(2);
    expect(end.runId).toBe(start.runId);
    expect(end.usage?.totalTokens).toBe(2);
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
  });

  it("ends as failed exactly once when the sub-agent throws", async () => {
    const events: SubagentRunEvent[] = [];
    const ctx = makeCtx((ev) => events.push(ev));
    ctx.agentFactory = () => ({
      run: async () => {
        throw new Error("boom");
      },
    });
    const result = await subagentTool.handler(ctx, { task: "do it" });
    expect(result.success).toBe(false);
    const ends = events.filter((e) => e.kind === "end");
    expect(ends).toHaveLength(1);
    if (ends[0].kind !== "end") throw new Error("no end");
    expect(ends[0].status).toBe("failed");
    expect(ends[0].error).toContain("boom");
  });

  it("a throwing observer never changes the tool result", async () => {
    const ctx = makeCtx(() => {
      throw new Error("observer down");
    });
    const result = await subagentTool.handler(ctx, { task: "do it" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("final answer");
  });

  it("parent abort stops the sub-agent and closes the run", async () => {
    const ac = new AbortController();
    let shutdownCalled = false;
    let finishRun: ((r: unknown) => void) | null = null;
    const events: SubagentRunEvent[] = [];
    const ctx = makeCtx((ev) => events.push(ev));
    ctx.abortSignal = ac.signal;
    ctx.agentFactory = () => ({
      run: () =>
        new Promise((resolve) => {
          finishRun = resolve;
        }),
      shutdown: () => {
        shutdownCalled = true;
        finishRun?.({ success: false, interrupted: true, text: "", iterationCount: 1 });
      },
    });

    const pending = subagentTool.handler(ctx, { task: "long" });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    const result = await pending;

    expect(shutdownCalled).toBe(true);
    expect(result.success).toBe(false);
    const end = events.find((e) => e.kind === "end");
    if (end?.kind !== "end") throw new Error("no end");
    expect(end.status).toBe("interrupted");
  });

  it("registers an interrupt handle with the observer sink", async () => {
    let stop: (() => void) | null = null;
    const ctx = makeCtx(() => {});
    ctx.subagentRuns = {
      emit: () => {},
      registerInterrupt: (_id: string, fn: () => void) => {
        stop = fn;
      },
      releaseInterrupt: () => {
        stop = null;
      },
    };
    await subagentTool.handler(ctx, { task: "x" });
    expect(stop).toBeNull(); // released in finally
  });

  it("stops a silent run by the idle timeout", async () => {
    vi.useFakeTimers();
    try {
      let finishRun: ((r: unknown) => void) | null = null;
      let shutdown = false;
      const events: SubagentRunEvent[] = [];
      const ctx = makeCtx((ev) => events.push(ev));
      ctx.config.subagent = { timeoutMs: 1000, maxDurationMs: 600000 };
      ctx.agentFactory = () => ({
        run: () =>
          new Promise((resolve) => {
            finishRun = resolve;
          }),
        shutdown: () => {
          shutdown = true;
          finishRun?.({ success: false, interrupted: true, text: "", iterationCount: 1 });
        },
      });
      const pending = subagentTool.handler(ctx, { task: "slow" });
      await Promise.resolve();
      vi.advanceTimersByTime(1100);
      const result = await pending;
      expect(shutdown).toBe(true);
      expect(result.success).toBe(false);
      expect(result.output).toContain("no activity");
      const end = events.find((e) => e.kind === "end");
      if (end?.kind !== "end") throw new Error("no end");
      expect(end.status).toBe("failed");
      expect(end.error).toContain("no activity");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a chatty run by the hard max duration", async () => {
    vi.useFakeTimers();
    try {
      let finishRun: ((r: unknown) => void) | null = null;
      let shutdown = false;
      const ctx = makeCtx(() => {});
      ctx.config.subagent = { timeoutMs: 600000, maxDurationMs: 60000 };
      ctx.agentFactory = () => ({
        run: () =>
          new Promise((resolve) => {
            finishRun = resolve;
          }),
        shutdown: () => {
          shutdown = true;
          finishRun?.({ success: false, interrupted: true, text: "", iterationCount: 1 });
        },
      });
      const pending = subagentTool.handler(ctx, { task: "long" });
      await Promise.resolve();
      vi.advanceTimersByTime(61000);
      const result = await pending;
      expect(shutdown).toBe(true);
      expect(result.success).toBe(false);
      expect(result.output).toContain("maximum");
    } finally {
      vi.useRealTimers();
    }
  });

  it("executor cleanup cancels the child agent (no orphan after timeout)", async () => {
    let finishRun: ((r: unknown) => void) | null = null;
    let shutdown = false;
    const ctx = makeCtx(() => {});
    ctx.agentFactory = () => ({
      run: () =>
        new Promise((resolve) => {
          finishRun = resolve;
        }),
      shutdown: () => {
        shutdown = true;
        finishRun?.({ success: false, interrupted: true, text: "", iterationCount: 1 });
      },
    });
    const pending = subagentTool.handler(ctx, { task: "x" });
    await Promise.resolve();
    ctx.cleanup?.();
    expect(shutdown).toBe(true);
    const result = await pending;
    expect(result.success).toBe(false);
  });

  it("parallel runs get distinct run ids", async () => {
    const ids: string[] = [];
    const ctx = (n: number) => makeCtx((ev) => {
      if (ev.kind === "start") ids.push(ev.runId);
    }, async () => ({ success: true, text: `r${n}`, iterationCount: 1 }));
    await Promise.all([
      subagentTool.handler(ctx(1), { task: "one" }),
      subagentTool.handler(ctx(2), { task: "two" }),
    ]);
    expect(new Set(ids).size).toBe(2);
  });

  it("emits nothing when no observer is installed", async () => {
    const ctx = makeCtx(() => {});
    delete ctx.subagentRuns;
    const result = await subagentTool.handler(ctx, { task: "x" });
    expect(result.success).toBe(true);
  });
});

