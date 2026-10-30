import { describe, it, expect, vi } from "vitest";
import { CriticGate, type CriticGateDeps } from "../../../src/core/agent/critic-gate";
import { noticeAfter } from "../../../src/core/agent/slow-notice";
import { createLoopState } from "../../../src/core/agent/loop-state";
import { DEFAULTS } from "../../../src/config/defaults";
import { CRITIC_GATE_BUDGET_MS, LLM_REQUEST_TIMEOUT_MS } from "../../../src/config/timeouts";

/**
 * A15: пост-обработка после ответа не должна держать ход минутами.
 *
 * Три инварианта:
 *  - `critic.budgetMs` — бюджет ОЖИДАНИЯ хода, он короче провайдерского
 *    дедлайна (в отличие от `critic.timeoutMs` — обёртки вокруг запроса);
 *  - провайдер, игнорирующий `signal`, не держит гейт дольше бюджета, и отказ
 *    записан (fail-open без записи неотличим от «проверил и ок»);
 *  - на неизменном входе, когда сказать больше нечего, повторного вызова нет.
 */

function gateDeps(over: Partial<CriticGateDeps> = {}) {
  const state = createLoopState();
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const metas: Array<{ text: string; kind?: string }> = [];
  const deps: CriticGateDeps = {
    state,
    iteration: 3,
    logger: { warn: vi.fn(), info: vi.fn(), diagnostic: vi.fn() } as never,
    contextManager: { addMessage: vi.fn() } as never,
    slog: {
      logCritic: (name: string, data: Record<string, unknown> = {}) => events.push({ name, data }),
      logDiagnosticEvent: (name: string, data: Record<string, unknown>) =>
        events.push({ name, data }),
    } as never,
    task: "do it",
    beforeFinish: true,
    toolEvents: [{ tool: "bash", args: { command: "ls" }, ok: true, output: "a.ts" }],
    answerText: "готово",
    onMeta: (text, kind) => metas.push({ text, kind }),
    ...over,
  };
  return { deps, events, metas, state };
}

const concern = {
  status: "concern" as const,
  summary: "gap",
  issues: [{ severity: "concern" as const, claim: "c", problem: "p" }],
};

describe("critic latency budget (A15)", () => {
  it("the gate budget is shorter than the provider deadline, the per-call wrapper is longer", () => {
    expect(CRITIC_GATE_BUDGET_MS).toBeGreaterThan(0);
    expect(CRITIC_GATE_BUDGET_MS).toBeLessThan(LLM_REQUEST_TIMEOUT_MS);
    // Два таймера не путаются: обёртка запроса по-прежнему длиннее дедлайна.
    expect(DEFAULTS.critic.timeoutMs).toBeGreaterThan(LLM_REQUEST_TIMEOUT_MS);
    expect(CRITIC_GATE_BUDGET_MS).toBeLessThan(DEFAULTS.critic.timeoutMs);
  });

  it("does not wait for a provider that ignores the abort signal", async () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      budgetMs: 40,
      // Провайдер не завершается и не слушает signal (живой кейс аудита).
      verify: () => new Promise(() => {}),
      buildPack: (x: never) => x,
    });

    const started = Date.now();
    expect(await gate.evaluate(d.deps)).toBe("pass");
    expect(Date.now() - started).toBeLessThan(1500);

    const verdict = d.events.find((e) => e.name === "critic_verdict");
    expect(verdict?.data).toMatchObject({ degraded: true, timedOut: true });
    expect(typeof verdict?.data.duration).toBe("number");
    const err = d.events.find((e) => e.name === "critic_error");
    expect(err?.data.cause).toContain("turn_budget");
    // Лента знает, что проверки не было.
    expect(d.metas).toHaveLength(1);
    expect(d.metas[0].kind).toBe("status");
  });

  it("does not call the verifier again on an unchanged pack with nothing new to say", async () => {
    const d = gateDeps();
    const verify = vi.fn(async () => concern);
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      budgetMs: CRITIC_GATE_BUDGET_MS,
      verify,
      buildPack: (x: never) => x,
    });

    // Первый вызов: свежая жалоба → совет (retry), и это фиксирует «больше нечего».
    expect(await gate.evaluate(d.deps)).toBe("retry");
    expect(verify).toHaveBeenCalledTimes(1);

    // Тот же вход, советный цикл исчерпан: платить второй вызов не за что.
    expect(await gate.evaluate(d.deps)).toBe("pass");
    expect(verify).toHaveBeenCalledTimes(1);
    const skipped = d.events.filter((e) => e.name === "critic_check").at(-1);
    expect(skipped?.data.skipped).toBe("unchanged_pack");
  });

  it("checks again as soon as the work changed", async () => {
    const d = gateDeps();
    const verify = vi.fn(async () => concern);
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      budgetMs: CRITIC_GATE_BUDGET_MS,
      verify,
      buildPack: (x: never) => x,
    });

    await gate.evaluate(d.deps);
    const changed: CriticGateDeps = { ...d.deps, answerText: "готово, но подробнее и длиннее" };
    await gate.evaluate(changed);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("announces a slow check once and stays silent when it finishes fast", async () => {
    vi.useFakeTimers();
    try {
      const slow = vi.fn();
      const stopSlow = noticeAfter(1000, slow);
      vi.advanceTimersByTime(1200);
      expect(slow).toHaveBeenCalledTimes(1);
      stopSlow();

      const fast = vi.fn();
      const stopFast = noticeAfter(1000, fast);
      stopFast();
      vi.advanceTimersByTime(5000);
      expect(fast).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
