import { describe, it, expect, beforeEach } from "vitest";
import { runWithMoE } from "../../src/core/agent-moe";
import { MoEExecutor } from "../../src/modules/execution/moe-executor";
import type { MoEPlan } from "../../src/modules/execution/types";
import type { AppConfig } from "../../src/config/types";
import { DEFAULTS } from "../../src/config/defaults";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolDefinition } from "../../src/tools/types";

function makeConfig(): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
  config.moe.enabled = true;
  return config;
}

function sub(id: string): MoEPlan["subtasks"][number] {
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

function planOf(ids: string[]): MoEPlan {
  return {
    title: "t",
    subtasks: ids.map(sub),
    shared_context: { rules: [], refs: [] },
  };
}

function abortError(): Error {
  const e = new Error("interrupted");
  e.name = "AbortError";
  return e;
}

describe("runWithMoE abort", () => {
  const seams = {
    planQueue: [] as any[],
    verifyQueue: [] as any[],
    execPlans: [] as MoEPlan[],
  };

  beforeEach(() => {
    seams.planQueue.length = 0;
    seams.verifyQueue.length = 0;
    seams.execPlans.length = 0;
  });

  function deps(config: AppConfig, signal?: AbortSignal) {
    return {
      config,
      llmProvider: {} as any,
      toolExecutor: { getRegistry: () => ({ getAll: () => [] }) } as any,
      logger: { debug: () => {}, warn: () => {}, info: () => {} } as any,
      baseDir: "/tmp/moe-abort-test",
      orchestratorOverride: {
        isEnabled: () => true,
        async plan() {
          const next = seams.planQueue.shift();
          if (!next) throw new Error("no plan scripted");
          if (next.error) return next;
          return { plan: next.plan, raw: "" };
        },
        async verifyAndMerge() {
          const next = seams.verifyQueue.shift();
          if (!next) throw new Error("no verify result");
          return next;
        },
        async resolveScopeRequest() {
          return { action: "reject" as const };
        },
      },
      executorOverride: {
        async executePlan(plan: MoEPlan) {
          seams.execPlans.push(plan);
          if (seams.execPlans.length === 1 && signal) {
            // simulate the user pressing Esc during the first execution
            (signal as any)._abortNow?.();
          }
          return {
            success: true,
            results: [
              { subtaskId: plan.subtasks[0]?.id ?? "a", success: true, summary: "ok", result: "", durationMs: 1 },
            ],
            errors: [],
            warnings: [],
          };
        },
      },
      verifierOverride: {
        async verifyMoEManifest() {
          return { success: true, errors: [], warnings: [] };
        },
      },
    };
  }

  it("throws AbortError without fallback when already aborted before planning", async () => {
    const controller = new AbortController();
    controller.abort();

    let fallbackCalled = false;
    await expect(
      runWithMoE(deps(makeConfig(), controller.signal), "task", async () => {
        fallbackCalled = true;
        return { success: false, text: "fallback", iterationCount: 0 };
      }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fallbackCalled).toBe(false);
    expect(seams.execPlans).toHaveLength(0);
  });

  it("does not start the re-plan cycle after abort during execution", async () => {
    const controller = new AbortController();
    (controller.signal as any)._abortNow = () => controller.abort();

    seams.planQueue.push({ plan: planOf(["a"]) });
    seams.verifyQueue.push({ type: "replan", plan: planOf(["a", "b"]), explanation: "retry" });

    await expect(
      runWithMoE(deps(makeConfig(), controller.signal), "task", async () => ({
        success: false,
        text: "fallback",
        iterationCount: 0,
      }), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(seams.execPlans).toHaveLength(1); // re-plan never started
  });
});

describe("MoEExecutor abort", () => {
  function makeExecutor(handler: any, signal?: AbortSignal): MoEExecutor {
    const registry = new ToolRegistry();
    const mockSubagentTool: ToolDefinition = {
      name: "subagent",
      description: "Mock",
      parameters: { type: "object", properties: {} },
      tags: ["code"],
      handler,
    };
    registry.register(mockSubagentTool);
    return new MoEExecutor({
      config: makeConfig(),
      toolRegistry: registry,
      toolExecutor: {} as any,
      llmProvider: {} as any,
      logger: { debug: () => {}, warn: () => {}, info: () => {} } as any,
      baseDir: "/tmp/moe-abort-exec",
      signal,
    });
  }

  it("skips queued subtasks once the signal is aborted", async () => {
    const controller = new AbortController();
    const started: string[] = [];

    const handler = async (_ctx: any, args: any) => {
      const id = String(args.task).match(/do (\w+)/)?.[1];
      started.push(id!);
      if (id === "a") controller.abort(); // interrupt while wave-1 runs
      return { success: true, output: "ok" };
    };

    // both subtasks are independent → same wave; after the wave barrier the
    // executor must throw instead of starting wave 2 / returning success
    await expect(
      makeExecutor(handler, controller.signal).executePlan(planOf(["a", "b"])),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(started).toContain("a");
    expect(started).not.toContain("b");
  });
});
