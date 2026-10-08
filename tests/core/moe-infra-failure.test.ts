import { describe, it, expect, beforeEach } from "vitest";
import { runWithMoE } from "../../src/core/agent-moe";
import type { MoEPlan } from "../../src/modules/execution/types";
import {
  makeMoEConfig,
  makeMoEScript,
  moeDeps,
  okResult,
  planOf as plan,
  type MoeScript,
} from "../helpers/moe-fixtures";

/**
 * Регрессия ses_muz7sg1l_0ankgu: оба сабтаска упали по инфраструктурной
 * ошибке провайдера, но верификатор объявил re-plan («это техническая
 * проблема, а не проблема контента») и цикл повторил то же самое. Правильное
 * поведение: инфраструктурный фейл не чинится перепланированием → честный
 * partial с РЕАЛЬНЫМ текстом ошибки, без вызова верификатора.
 */
const h = makeMoEScript() as MoeScript & { execPlans: MoEPlan[]; execResults: unknown[] };
h.execPlans = [];
h.execResults = [];

const INFRA_ERROR =
  'Failed to load model "qwen/qwen3.5-9b". Error: Engine protocol startup was aborted.';

const fakeExecutor = {
  async executePlan(p: MoEPlan) {
    h.execPlans.push(p);
    const next = h.execResults.shift();
    if (!next) throw new Error("no exec result scripted");
    return next as never;
  },
};

/** Deps `runWithMoE`: фейковый оркестратор + исполнятель по сценарию. */
function deps(opts?: { maxReplanCycles?: number }) {
  return {
    ...moeDeps(makeMoEConfig(opts), h),
    logger: { debug: () => {}, warn: () => {}, info: () => {}, diagnostic: () => {} },
    executorOverride: fakeExecutor,
  };
}

/** Фолбэк на single-agent: успешный путь не должен его трогать. */
const fallback = async () => ({ success: false, text: "fallback", iterationCount: 0 });

function infraFailurePlan(ids: string[]) {
  return {
    success: false,
    results: ids.map((id) => ({
      ...okResult(id),
      success: false,
      summary: `Failed: ${id}`,
      error: INFRA_ERROR,
    })),
    errors: ids.map((id) => `[${id}] ${INFRA_ERROR}`),
    warnings: [],
  };
}

describe("runWithMoE infrastructure failures", () => {
  beforeEach(() => {
    h.planQueue.length = 0;
    h.verifyQueue.length = 0;
    h.execPlans.length = 0;
    h.execResults.length = 0;
  });

  it("stops with an honest partial failure instead of re-planning", async () => {
    h.planQueue.push({ plan: plan("a", "b") });
    h.execResults.push(infraFailurePlan(["a", "b"]));

    const result = await runWithMoE(deps({ maxReplanCycles: 3 }), "do the thing", fallback);

    // Один цикл: re-plan на инфраструктурной ошибке не запускается.
    expect(h.execPlans).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Engine protocol startup was aborted");
    // Причина видна в тексте ответа, а не только «Failed: task-2».
    expect(result.text).toContain("Engine protocol startup was aborted");
  });

  it("does not call the verifier for an infra-only failure", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.execResults.push(infraFailurePlan(["a"]));
    // В verifyQueue ничего не кладём: вызов = throw.

    const result = await runWithMoE(deps(), "task", fallback);

    expect(result.success).toBe(false);
    expect(h.verifyQueue).toHaveLength(0);
  });

  it("logs the failure reason to session.jsonl via moe_verify", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.execResults.push(infraFailurePlan(["a"]));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    await runWithMoE(deps(), "task", fallback, { onEvent: (e) => events.push(e) });

    const verify = events.find((e) => e.type === "moe_verify");
    expect(verify?.data.decision).toBe("infra_failure");
    expect(String(verify?.data.explanation)).toContain("Engine protocol startup was aborted");
  });

  it("still re-plans on a content failure", async () => {
    h.planQueue.push({ plan: plan("a") });
    h.execResults.push({
      success: false,
      results: [{ ...okResult("a"), success: false, error: "assertion failed: expected 3 files" }],
      errors: ["[a] assertion failed"],
      warnings: [],
    });
    h.verifyQueue.push({ type: "replan", plan: plan("a", "a2"), explanation: "content" });
    h.execResults.push({ success: true, results: [okResult("a"), okResult("a2")], errors: [], warnings: [] });
    h.verifyQueue.push({ type: "final", finalAnswer: "done" });

    const result = await runWithMoE(deps(), "task", fallback);

    expect(h.execPlans).toHaveLength(2);
    expect(result.success).toBe(true);
  });

  it("records a terminal moe_verify entry when the turn is aborted", async () => {
    const abort = new Error("interrupted");
    abort.name = "AbortError";
    h.planQueue.push({ plan: plan("a") });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const throwingExecutor = {
      async executePlan(): Promise<never> {
        throw abort;
      },
      getUsageByTag: () => undefined,
    };

    await expect(
      runWithMoE(
        { ...deps(), executorOverride: throwingExecutor },
        "task",
        fallback,
        { onEvent: (e) => events.push(e) },
      ),
    ).rejects.toThrow("interrupted");

    const verify = events.find((e) => e.type === "moe_verify");
    expect(verify?.data.decision).toBe("aborted");
  });
});
