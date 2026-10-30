// Retract только при реальном переответе: понижённый повтор не должен
// удалять из ленты ответ, который сервер принимает как финальный.
import { describe, it, expect, vi } from "vitest";
import { HallucinationGate } from "../../src/core/agent/hallucination-gate";
import { createLoopState } from "../../src/core/agent/loop-state";

function harness(detector: unknown, opts: { suppress?: boolean; retries?: number } = {}) {
  const metas: Array<{ text: string; kind?: string }> = [];
  const claims: Array<Record<string, unknown>> = [];
  const state = createLoopState();
  state.suppressRepetitionRetry = !!opts.suppress;
  state.hallucinationRetries = opts.retries ?? 0;
  const deps = {
    state,
    textContent: "Погода в Минске: +8°, облачно",
    input: "какая погода в Минске?",
    exitOnComplete: false,
    hasFinalAudit: false,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      diagnostic: () => {},
    },
    contextManager: { addMessage: () => {}, getActiveHistory: () => [] },
    onMeta: (text: string, kind?: string) => metas.push({ text, kind }),
    onChunk: undefined,
    verbose: false,
    slog: { logClaimRetry: (d: Record<string, unknown>) => claims.push(d) },
  } as never;
  return { deps, metas, claims, state };
}

const retryDetector = (kind: string, reason: string) =>
  ({
    validate: () => ({ status: "retry", kind, reason }),
    getConfidenceCheck: () => ({ setPreviousResponse: () => {} }),
  }) as never;

describe("hallucination retract follows the actual decision", () => {
  it("does not retract an accepted repetition downgrade", async () => {
    const gate = new HallucinationGate(retryDetector("repetition", "93% overlap"));
    const { deps, metas, claims, state } = harness(null, { suppress: true });
    const verdict = await gate.evaluate(deps);
    expect(verdict.action).toBe("accept");
    expect(metas.filter((m) => m.kind === "retract")).toHaveLength(0);
    expect(claims).toHaveLength(0);
    expect(state.suppressRepetitionRetry).toBe(false);
  });

  it("retracts exactly once when a retry really happens", async () => {
    const gate = new HallucinationGate(retryDetector("diversity", "too narrow"));
    const { deps, metas, claims } = harness(null);
    const verdict = await gate.evaluate(deps);
    expect(verdict.action).toBe("retry");
    expect(metas.filter((m) => m.kind === "retract")).toHaveLength(1);
    expect(claims).toHaveLength(1);
    expect(claims[0].reason).toBe("too narrow");
  });

  it("retracts before blocking so the rejected draft does not stay", async () => {
    const gate = new HallucinationGate(retryDetector("short", "too short"));
    const { deps, metas } = harness(null, { retries: 99 });
    const verdict = await gate.evaluate(deps);
    expect(verdict.action).toBe("block");
    expect(metas.filter((m) => m.kind === "retract")).toHaveLength(1);
  });

  it("retracts on a claim retry (a new answer is guaranteed)", async () => {
    const gate = new HallucinationGate(retryDetector("short", "short"));
    const { deps, metas } = harness(null);
    // claim-путь всегда возвращает retry и тоже обязан уведомить ленту.
    const verdict = await gate.evaluate({ ...deps, textContent: "Готово, всё опубликовано" });
    expect(verdict.action).toBe("retry");
    expect(metas.some((m) => m.kind === "retract")).toBe(true);
  });
});
