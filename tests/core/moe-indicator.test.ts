// Индикатор MoE: одна строка чата на ход + факт «MoE ведёт ход» (`onMoEState`)
// для чипа режима в вебе. Проверяем ungate прогресса, verbose-only шум и то, что
// флаг гаснет на всех путях выхода (фолбэк, ошибка, Esc).
import { describe, it, expect, beforeEach } from "vitest";
import { runWithMoE } from "../../src/core/agent-moe";
import type { PlanResult } from "../../src/modules/execution/types";
import {
  makeMoEConfig,
  makeMoEScript,
  moeDeps,
  okExecutor,
  planOf,
  resetMoE,
  singleAgentFallback,
  type MoeScript,
} from "../helpers/moe-fixtures";

const h: MoeScript = makeMoEScript();

/** Прогон с собранными meta-строками и флагом «MoE ведёт ход». */
function run(opts: {
  config?: ReturnType<typeof makeMoEConfig>;
  executor?: { executePlan(p: never): Promise<PlanResult>; getUsageByTag(): undefined };
  signal?: AbortSignal;
}) {
  const meta: string[] = [];
  const states: boolean[] = [];
  const promise = runWithMoE(
    {
      ...(moeDeps(opts.config ?? makeMoEConfig(), h) as never),
      executorOverride: opts.executor ?? okExecutor(),
    },
    "task",
    singleAgentFallback,
    {
      onMeta: (m: string) => meta.push(m),
      onMoEState: (a: boolean) => states.push(a),
      signal: opts.signal,
    },
  );
  return { promise, meta, states };
}

describe("MoE indicator: chat lines", () => {
  beforeEach(() => resetMoE(h));

  it("prints exactly one start line and one finish line per turn at default verbosity", async () => {
    h.planQueue.push({ plan: planOf("a", "b") });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });
    const { promise, meta } = run({});

    await promise;

    expect(meta).toHaveLength(2);
    expect(meta[0]).toContain("MoE");
    expect(meta[0]).toContain("2");
    expect(meta[1]).toContain("2/2");
  });

  it("announces the start line only once across re-plan cycles", async () => {
    h.planQueue.push({ plan: planOf("a") });
    h.verifyQueue.push({ type: "replan", plan: planOf("fix"), explanation: "retry" });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });
    const { promise, meta } = run({ config: makeMoEConfig({ verbose: true }) });

    await promise;

    const starts = meta.filter((m) => m.includes("MoE") && m.includes("1"));
    expect(starts).toHaveLength(1);
  });

  it("keeps re-plan chatter out of the chat at default verbosity", async () => {
    h.planQueue.push({ plan: planOf("a") });
    h.verifyQueue.push({ type: "replan", plan: planOf("fix"), explanation: "retry" });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });
    const { promise, meta } = run({});

    await promise;

    expect(meta.some((m) => /re-plan/i.test(m))).toBe(false);
    expect(meta).toHaveLength(2);
  });

  it("reports a broken merge as a failure line, not a success tally", async () => {
    h.planQueue.push({ plan: planOf("a") });
    // verifyAndMerge без результата в очереди бросает — ход обрывается на слиянии.
    const { promise, meta } = run({});

    const result = await promise;

    expect(result.success).toBe(false);
    expect(meta.some((m) => m.includes("MoE"))).toBe(true);
    expect(meta.some((m) => m.includes("1/1"))).toBe(false);
  });

  it("reports a partial result when re-plan cycles are exhausted", async () => {
    h.planQueue.push({ plan: planOf("a") });
    // Каждый цикл просит re-plan → лимит циклов исчерпан, успеха нет.
    for (let i = 0; i < 5; i++) {
      h.verifyQueue.push({ type: "replan", plan: planOf(`fix${i}`), explanation: "retry" });
    }
    const { promise, meta } = run({});

    await promise;

    expect(meta.filter((m) => m.includes("MoE"))).toHaveLength(2);
  });
});

describe("MoE indicator: onMoEState", () => {
  beforeEach(() => resetMoE(h));

  it("reports active=true then false around a real MoE turn", async () => {
    h.planQueue.push({ plan: planOf("a") });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });
    const { promise, states } = run({});

    await promise;

    expect(states).toEqual([true, false]);
  });

  it("never reports active when MoE falls back to the single-agent loop", async () => {
    h.enabled = false;
    const { promise, states } = run({});

    const result = await promise;

    expect(states).toEqual([]);
    expect(result.text).toBe("fallback");
  });

  it("never reports active when planning fails", async () => {
    h.planQueue.push({ error: "planner down" });
    const { promise, states } = run({});

    await promise;

    expect(states).toEqual([]);
  });

  it("clears the flag on abort (Esc) so the indicator cannot stick", async () => {
    h.planQueue.push({ plan: planOf("a") });
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
    const { promise, states } = run({
      executor: abortingExecutor as never,
      signal: controller.signal,
    });

    await expect(promise).rejects.toThrow();

    expect(states[0]).toBe(true);
    expect(states[states.length - 1]).toBe(false);
  });
});