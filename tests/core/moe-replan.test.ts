import { describe, it, expect, beforeEach } from "vitest";
import { runWithMoE, type MoEOrchestratorLike } from "../../src/core/agent-moe";
import type { MoEPlan, SubtaskResult } from "../../src/modules/execution/types";
import type { AppConfig } from "../../src/config/types";
import { DEFAULTS } from "../../src/config/defaults";

const h = {
  planQueue: [] as Array<{ plan?: MoEPlan; raw?: string; error?: string }>,
  verifyQueue: [] as any[],
  execPlans: [] as MoEPlan[],
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

const fakeExecutor = {
  async executePlan(plan: MoEPlan) {
    h.execPlans.push(plan);
    const next = h.execResults.shift();
    if (!next) throw new Error("no exec result scripted");
    return next;
  },
};

const fakeVerifier = {
  async verifyMoEManifest() {
    return { success: true, errors: [], warnings: [] };
  },
};

function makeConfig(maxReplanCycles?: number): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
  config.moe.enabled = true;
  if (maxReplanCycles !== undefined) {
    (config.moe as any).maxReplanCycles = maxReplanCycles;
  }
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

function deps(config: AppConfig) {
  return {
    config,
    llmProvider: {} as any,
    toolExecutor: { getRegistry: () => ({ getAll: () => [] }) } as any,
    logger: { debug: () => {}, warn: () => {}, info: () => {} } as any,
    baseDir: "/tmp/moe-test",
    orchestratorOverride: fakeOrchestrator(),
    executorOverride: fakeExecutor,
    verifierOverride: fakeVerifier,
  };
}

describe("runWithMoE re-plan loop", () => {
  beforeEach(() => {
    h.planQueue.length = 0;
    h.verifyQueue.length = 0;
    h.execPlans.length = 0;
    h.execResults.length = 0;
  });

  it("executes the re-plan when verifier requests it and returns merged results", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.execResults.push({
      success: false,
      results: [{ ...okResult("a"), success: false, summary: "fail a", error: "boom" }],
      errors: ["[a] boom"],
      warnings: [],
    });
    h.verifyQueue.push({
      type: "replan",
      plan: plan("a", "fix"),
      explanation: "a failed",
    });
    h.execResults.push({
      success: true,
      results: [okResult("a"), okResult("fix")],
      errors: [],
      warnings: [],
    });
    h.verifyQueue.push({ type: "final", finalAnswer: "all done" });

    const fallback = async () => ({ success: false, text: "fallback", iterationCount: 0 });
    const result = await runWithMoE(deps(makeConfig()), "do the thing", fallback);

    expect(h.execPlans).toHaveLength(2);
    expect(h.execPlans[1].subtasks.map((s) => s.id)).toEqual(["a", "fix"]);
    expect(result.success).toBe(true);
    expect(result.text).toContain("fix");
    expect(result.text).toContain("all done");
  });

  it("stops after maxReplanCycles and reports partial failure honestly", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.execResults.push({
      success: false,
      results: [{ ...okResult("a"), success: false, error: "boom" }],
      errors: ["[a] boom"],
      warnings: [],
    });
    h.verifyQueue.push({ type: "replan", plan: plan("a"), explanation: "retry 1" });
    h.execResults.push({
      success: false,
      results: [{ ...okResult("a"), success: false, error: "boom again" }],
      errors: ["[a] boom again"],
      warnings: [],
    });
    h.verifyQueue.push({ type: "replan", plan: plan("a"), explanation: "retry 2" });

    const fallback = async () => ({ success: false, text: "fallback", iterationCount: 0 });
    const result = await runWithMoE(deps(makeConfig(2)), "do the thing", fallback);

    // initial cycle + 1 re-plan (maxReplanCycles=2 total cycles)
    expect(h.execPlans).toHaveLength(2);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("rejects an invalid re-plan instead of executing it", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.execResults.push({
      success: false,
      results: [{ ...okResult("a"), success: false, error: "boom" }],
      errors: ["[a] boom"],
      warnings: [],
    });
    h.verifyQueue.push({
      type: "replan",
      plan: {
        title: "bad",
        subtasks: [
          {
            id: "x",
            description: "",
            expert_tag: "does-not-exist",
            allowed_files: [],
            read_only_files: [],
            depends_on: [],
            input_from: [],
            expected_output: "",
            success_criteria: [],
          },
        ],
        shared_context: { rules: [], refs: [] },
      },
      explanation: "try unknown expert",
    });

    const fallback = async () => ({ success: false, text: "fallback", iterationCount: 0 });
    const result = await runWithMoE(deps(makeConfig(3)), "do the thing", fallback);

    expect(h.execPlans).toHaveLength(1); // invalid re-plan never executed
    expect(result.success).toBe(false);
    expect(result.error).toContain("does-not-exist");
  });

  it("returns final answer without re-plan on first-cycle success", async () => {
    h.planQueue.push({ plan: plan("a", "b") });
    h.execResults.push({ success: true, results: [okResult("a"), okResult("b")], errors: [], warnings: [] });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });

    const fallback = async () => ({ success: false, text: "fallback", iterationCount: 0 });
    const result = await runWithMoE(deps(makeConfig()), "easy task", fallback);

    expect(h.execPlans).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.text).toContain("done");
  });

  it("falls back when orchestrator is not configured", async () => {
    const d = deps(makeConfig());
    (d.orchestratorOverride as any).isEnabled = () => false;

    const fallback = async () => ({ success: false, text: "fallback", iterationCount: 0 });
    const result = await runWithMoE(d, "task", fallback);

    expect(result.text).toBe("fallback");
  });
});
