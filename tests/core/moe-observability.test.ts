import { describe, it, expect, beforeEach } from "vitest";
import { runWithMoE, type MoEEvent, type MoEOrchestratorLike } from "../../src/core/agent-moe";
import type { MoEPlan, SubtaskResult, PlanResult } from "../../src/modules/execution/types";
import type { AppConfig } from "../../src/config/types";
import { DEFAULTS } from "../../src/config/defaults";
import type { MoEExecutorDeps, TagUsage } from "../../src/modules/execution/moe-executor";

const h = {
  planQueue: [] as Array<{ plan?: MoEPlan; raw?: string; error?: string }>,
  verifyQueue: [] as any[],
  execResults: [] as any[],
};

function fakeOrchestrator(): MoEOrchestratorLike {
  return {
    isEnabled: () => true,
    async plan() {
      const next = h.planQueue.shift();
      if (!next) return { error: "no plan scripted" };
      return next as any;
    },
    async verifyAndMerge() {
      const next = h.verifyQueue.shift();
      if (!next) throw new Error("no verify result scripted");
      return next;
    },
  };
}

function makeConfig(): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
  config.moe.enabled = true;
  return config;
}

function subtask(id: string): MoEPlan["subtasks"][number] {
  return {
    id,
    description: `do ${id}`,
    expert_tag: "code",
    allowed_files: [],
    read_only_files: [],
    depends_on: [],
    input_from: [],
    expected_output: "",
    success_criteria: [],
  };
}

function plan(...ids: string[]): MoEPlan {
  return {
    title: "test plan",
    subtasks: ids.map(subtask),
    shared_context: { rules: [], refs: [] },
  };
}

function okResult(id: string): SubtaskResult {
  return {
    subtaskId: id,
    success: true,
    summary: `ok ${id}`,
    result: `${id} output`,
    durationMs: 1,
  };
}

function deps() {
  return {
    config: makeConfig(),
    llmProvider: {} as any,
    toolExecutor: { getRegistry: () => ({ getAll: () => [] }) } as any,
    logger: { debug: () => {}, warn: () => {}, info: () => {} } as any,
    baseDir: "/tmp/moe-obs-test",
    orchestratorOverride: fakeOrchestrator(),
    verifierOverride: {
      async verifyMoEManifest() {
        return { success: true, errors: [], warnings: [] };
      },
    },
  };
}

describe("MoE observability events (Plan 4.2)", () => {
  beforeEach(() => {
    h.planQueue.length = 0;
    h.verifyQueue.length = 0;
    h.execResults.length = 0;
  });

  it("emits moe_plan and moe_verify events for a successful single-cycle run", async () => {
    h.planQueue.push({ plan: plan("a") });
    const events: MoEEvent[] = [];
    const executorOverride = {
      async executePlan(p: MoEPlan): Promise<PlanResult> {
        return { success: true, results: p.subtasks.map((s) => okResult(s.id)), errors: [], warnings: [] };
      },
      getUsageByTag() {
        return {
          code: { promptTokens: 100, completionTokens: 50, totalTokens: 150, subtasks: 1 },
        };
      },
    };

    h.execResults.push({ success: true, results: [okResult("a")], errors: [], warnings: [] });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });

    await runWithMoE(
      { ...deps(), executorOverride },
      "task",
      async () => ({ success: false, text: "fallback", iterationCount: 0 }),
      { onEvent: (e) => events.push(e) },
    );

    const planEvent = events.find((e) => e.type === "moe_plan");
    expect(planEvent).toBeDefined();
    expect(planEvent!.data.status).toBe("ok");
    expect(planEvent!.data.subtaskIds).toEqual(["a"]);

    const verifyEvent = events.find((e) => e.type === "moe_verify");
    expect(verifyEvent).toBeDefined();
    expect(verifyEvent!.data.decision).toBe("final");
    expect(verifyEvent!.data.usageByTag).toEqual({
      code: { promptTokens: 100, completionTokens: 50, totalTokens: 150, subtasks: 1 },
    });
  });

  it("emits moe_plan error event when planning fails", async () => {
    h.planQueue.push({ error: "planner down" });
    const events: MoEEvent[] = [];

    await runWithMoE(deps(), "task", async () => ({ success: false, text: "fallback", iterationCount: 0 }), {
      onEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("moe_plan");
    expect(events[0].data.status).toBe("error");
  });

  it("emits moe_replan event on cycles after the first", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.execResults.push({
      success: false,
      results: [{ ...okResult("a"), success: false, error: "boom" }],
      errors: ["[a] boom"],
      warnings: [],
    });
    h.verifyQueue.push({ type: "replan", plan: plan("fix"), explanation: "retry" });
    h.execResults.push({ success: true, results: [okResult("fix")], errors: [], warnings: [] });
    h.verifyQueue.push({ type: "final", finalAnswer: "all done" });

    const events: MoEEvent[] = [];
    await runWithMoE(
      {
        ...deps(),
        executorOverride: {
          async executePlan(p: MoEPlan): Promise<PlanResult> {
            return { success: true, results: p.subtasks.map((s) => okResult(s.id)), errors: [], warnings: [] };
          },
        },
      },
      "task",
      async () => ({ success: false, text: "fallback", iterationCount: 0 }),
      { onEvent: (e) => events.push(e) },
    );

    const replan = events.find((e) => e.type === "moe_replan");
    expect(replan).toBeDefined();
    expect(replan!.data.cycle).toBe(2);
    expect(replan!.data.subtaskIds).toEqual(["fix"]);
  });
});

describe("MoEExecutor subtask events + sessionId", () => {
  function makeSubagentTool(handler: (ctx: any) => Promise<any>): any {
    return {
      name: "subagent",
      description: "",
      parameters: { required: [], properties: {} },
      tags: ["file", "code", "shell"],
      handler,
    };
  }

  function executorDeps(overrides?: Partial<MoEExecutorDeps>): MoEExecutorDeps {
    const subagentTool = makeSubagentTool(async () => ({
      success: true,
      output: "sub ok",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }));
    return {
      config: makeConfig(),
      toolRegistry: {
        getAll: () => [subagentTool],
        get: (name: string) => (name === "subagent" ? subagentTool : undefined),
      } as any,
      toolExecutor: {} as any,
      llmProvider: {} as any,
      logger: { debug: () => {}, warn: () => {}, info: () => {} } as any,
      baseDir: "/tmp/moe-obs-test",
      ...overrides,
    };
  }

  it("emits moe_subtask start/done events and accumulates usage by expert_tag", async () => {
    const { MoEExecutor } = await import("../../src/modules/execution/moe-executor");
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const executor = new MoEExecutor(
      executorDeps({ onEvent: (e) => events.push(e), sessionId: "ses_real_42" }),
    );
    const result = await executor.executePlan(plan("a", "b"));

    expect(result.success).toBe(true);
    const start = events.filter((e) => e.data.status === "start");
    const done = events.filter((e) => e.data.status === "done");
    expect(start).toHaveLength(2);
    expect(done).toHaveLength(2);
    expect(done[0].data.subtaskId).toBeDefined();
    expect(done[0].data.expertTag).toBe("code");
    expect(done[0].data.durationMs).toBeTypeOf("number");

    const usage: Record<string, TagUsage> = executor.getUsageByTag();
    expect(usage.code).toEqual({
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      subtasks: 2,
    });
  });

  it("propagates the real sessionId into the subagent tool context", async () => {
    const { MoEExecutor } = await import("../../src/modules/execution/moe-executor");
    let capturedSessionId: string | undefined;
    const deps = executorDeps({ sessionId: "ses_real_42" });
    const subagentTool = makeSubagentTool(async (ctx: any) => {
      capturedSessionId = ctx.sessionId;
      return { success: true, output: "sub ok" };
    });
    deps.toolRegistry = {
      getAll: () => [subagentTool],
      get: (name: string) => (name === "subagent" ? subagentTool : undefined),
    } as any;

    const executor = new MoEExecutor(deps);
    await executor.executePlan(plan("a"));
    expect(capturedSessionId).toBe("ses_real_42");
  });
});
