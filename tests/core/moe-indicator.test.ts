// Индикатор MoE: одна строка чата на ход + факт «MoE ведёт ход» (`onMoEState`)
// для чипа режима в вебе. Проверяем ungate прогресса, verbose-only шум и то, что
// флаг гаснет на всех путях выхода (фолбэк, ошибка, Esc).
import { describe, it, expect, beforeEach } from "vitest";
import { runWithMoE, type MoEOrchestratorLike } from "../../src/core/agent-moe";
import type { MoEPlan, SubtaskResult, PlanResult } from "../../src/modules/execution/types";
import type { AppConfig } from "../../src/config/types";
import { DEFAULTS } from "../../src/config/defaults";

const h = {
  planQueue: [] as Array<{ plan?: MoEPlan; raw?: string; error?: string }>,
  verifyQueue: [] as any[],
  enabled: true,
};

function fakeOrchestrator(): MoEOrchestratorLike {
  return {
    isEnabled: () => h.enabled,
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

function makeConfig(verbose = false): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
  config.moe.enabled = true;
  config.ui.verbose = verbose;
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
  return { subtaskId: id, success: true, summary: `ok ${id}`, result: `${id} out`, durationMs: 1 };
}

function okExecutor(): any {
  return {
    async executePlan(p: MoEPlan): Promise<PlanResult> {
      return {
        success: true,
        results: p.subtasks.map((s) => okResult(s.id)),
        errors: [],
        warnings: [],
      };
    },
    getUsageByTag: () => undefined,
  };
}

function deps(config = makeConfig()): any {
  return {
    config,
    llmProvider: {} as any,
    toolExecutor: { getRegistry: () => ({ getAll: () => [] }) } as any,
    logger: { debug: () => {}, warn: () => {}, info: () => {} } as any,
    baseDir: "/tmp/moe-indicator-test",
    orchestratorOverride: fakeOrchestrator(),
    verifierOverride: {
      async verifyMoEManifest() {
        return { success: true, errors: [], warnings: [] };
      },
    },
  };
}

const fallback = async () => ({ success: false, text: "fallback", iterationCount: 0 });

describe("MoE indicator: chat lines", () => {
  beforeEach(() => {
    h.planQueue.length = 0;
    h.verifyQueue.length = 0;
    h.enabled = true;
  });

  it("prints exactly one start line and one finish line per turn at default verbosity", async () => {
    h.planQueue.push({ plan: plan("a", "b") });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });
    const meta: string[] = [];

    await runWithMoE({ ...deps(), executorOverride: okExecutor() }, "task", fallback, {
      onMeta: (m: string) => meta.push(m),
    });

    expect(meta).toHaveLength(2);
    expect(meta[0]).toContain("MoE");
    expect(meta[0]).toContain("2");
    expect(meta[1]).toContain("2/2");
  });

  it("announces the start line only once across re-plan cycles", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.verifyQueue.push({ type: "replan", plan: plan("fix"), explanation: "retry" });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });
    const meta: string[] = [];

    await runWithMoE({ ...deps(makeConfig(true)), executorOverride: okExecutor() }, "task", fallback, {
      onMeta: (m: string) => meta.push(m),
    });

    const starts = meta.filter((m) => m.includes("MoE") && m.includes("1"));
    expect(starts).toHaveLength(1);
  });

  it("keeps re-plan chatter out of the chat at default verbosity", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.verifyQueue.push({ type: "replan", plan: plan("fix"), explanation: "retry" });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });
    const meta: string[] = [];

    await runWithMoE({ ...deps(), executorOverride: okExecutor() }, "task", fallback, {
      onMeta: (m: string) => meta.push(m),
    });

    expect(meta.some((m) => m.includes("Re-plan") || m.includes("re-plan"))).toBe(false);
    expect(meta).toHaveLength(2);
  });

  it("reports a broken merge as a failure line, not a success tally", async () => {
    h.planQueue.push({ plan: plan("a") });
    const meta: string[] = [];

    // verifyAndMerge без результата в очереди бросает — ход обрывается на слиянии.
    const result = await runWithMoE(
      { ...deps(), executorOverride: okExecutor() },
      "task",
      fallback,
      { onMeta: (m: string) => meta.push(m) },
    );

    expect(result.success).toBe(false);
    expect(meta.filter((m) => m.includes("MoE")).length).toBeGreaterThanOrEqual(1);
    expect(meta.some((m) => m.includes("1/1"))).toBe(false);
  });

  it("reports a partial result when re-plan cycles are exhausted", async () => {
    h.planQueue.push({ plan: plan("a") });
    const meta: string[] = [];

    // Каждый цикл просит re-plan → лимит циклов исчерпан, успеха нет.
    for (let i = 0; i < 5; i++) {
      h.verifyQueue.push({ type: "replan", plan: plan(`fix${i}`), explanation: "retry" });
    }

    await runWithMoE({ ...deps(), executorOverride: okExecutor() }, "task", fallback, {
      onMeta: (m: string) => meta.push(m),
    });

    expect(meta.some((m) => m.includes("MoE") && m.includes("/"))).toBe(true);
    expect(meta.filter((m) => m.includes("MoE"))).toHaveLength(2);
  });
});

describe("MoE indicator: onMoEState", () => {
  beforeEach(() => {
    h.planQueue.length = 0;
    h.verifyQueue.length = 0;
    h.enabled = true;
  });

  it("reports active=true then false around a real MoE turn", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });
    const states: boolean[] = [];

    await runWithMoE({ ...deps(), executorOverride: okExecutor() }, "task", fallback, {
      onMoEState: (a) => states.push(a),
    });

    expect(states).toEqual([true, false]);
  });

  it("never reports active when MoE falls back to the single-agent loop", async () => {
    h.enabled = false;
    const states: boolean[] = [];

    const result = await runWithMoE({ ...deps(), executorOverride: okExecutor() }, "task", fallback, {
      onMoEState: (a) => states.push(a),
    });

    expect(states).toEqual([]);
    expect(result.text).toBe("fallback");
  });

  it("never reports active when planning fails", async () => {
    h.planQueue.push({ error: "planner down" });
    const states: boolean[] = [];

    await runWithMoE({ ...deps(), executorOverride: okExecutor() }, "task", fallback, {
      onMoEState: (a) => states.push(a),
    });

    expect(states).toEqual([]);
  });

  it("clears the flag on abort (Esc) so the indicator cannot stick", async () => {
    h.planQueue.push({ plan: plan("a") });
    const states: boolean[] = [];
    const controller = new AbortController();

    const abortingExecutor = {
      async executePlan(): Promise<PlanResult> {
        controller.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
      getUsageByTag: () => undefined,
    };

    await expect(
      runWithMoE({ ...deps(), executorOverride: abortingExecutor }, "task", fallback, {
        signal: controller.signal,
        onMoEState: (a) => states.push(a),
      }),
    ).rejects.toThrow();

    expect(states[0]).toBe(true);
    expect(states[states.length - 1]).toBe(false);
  });
});