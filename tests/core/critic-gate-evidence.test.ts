/**
 * A6: гейт понижает `critical` без улики в жалобах до `concern` (ремонт не
 * тратится), а `critic_check` несёт состав улик (тул + ключевой аргумент).
 */
import { describe, it, expect, vi } from "vitest";
import { CriticGate } from "../../src/core/agent/critic-gate";
import { createLoopState } from "../../src/core/agent/loop-state";
import type { CriticGateDeps } from "../../src/core/agent/critic-contract";
import type { CriticVerdict, EvidencePack } from "../../src/modules/critic/types";

interface Harness {
  gate: CriticGate;
  state: ReturnType<typeof createLoopState>;
  checks: Array<Record<string, unknown>>;
  verdicts: Array<Record<string, unknown>>;
  makeDeps: (over?: Partial<CriticGateDeps>) => CriticGateDeps;
}

function makeHarness(verdict: CriticVerdict): Harness {
  const state = createLoopState();
  const checks: Array<Record<string, unknown>> = [];
  const verdicts: Array<Record<string, unknown>> = [];
  const slog = {
    logCritic: vi.fn((event: string, data: Record<string, unknown>) => {
      if (event === "critic_check") checks.push(data);
      if (event === "critic_verdict") verdicts.push(data);
    }),
    logRetract: vi.fn(),
    logDiagnosticEvent: vi.fn(),
  };
  const gate = new CriticGate({
    enabled: true,
    maxCalls: 4,
    maxRepairCycles: 1,
    verify: (async () => verdict) as unknown as (
      pack: EvidencePack,
    ) => Promise<CriticVerdict | null>,
    buildPack: () => ({}) as EvidencePack,
  });
  const makeDeps = (over: Partial<CriticGateDeps> = {}): CriticGateDeps =>
    ({
      state,
      iteration: 1,
      logger: { diagnostic: vi.fn() },
      contextManager: { addMessage: vi.fn() },
      slog,
      task: "check the numbers",
      toolEvents: [{ tool: "read_file", ok: true, args: { path: "src/a.ts" }, output: "x" }],
      beforeFinish: true,
      answerText: "the index says 1487",
      onMeta: vi.fn(),
      ...over,
    }) as unknown as CriticGateDeps;
  return { gate, state, checks, verdicts, makeDeps };
}

const NO_EVIDENCE: CriticVerdict = {
  status: "critical",
  summary: "numbers look wrong",
  issues: [{ severity: "critical", claim: "1487", problem: "actually >4000" }],
};

describe("critic gate: провенанс (A6)", () => {
  it("critical без улики идёт советом, repair-бюджет не тратится", async () => {
    const h = makeHarness(NO_EVIDENCE);
    expect(await h.gate.evaluate(h.makeDeps())).toBe("retry");
    expect(h.state.criticRepairCycles).toBe(0);
    const logged = h.verdicts.at(-1)!;
    expect(logged.status).toBe("concern");
    expect(logged.downgraded).toBe("no_evidence");
  });

  it("critical с уликой ремонтируется как раньше", async () => {
    const h = makeHarness({
      ...NO_EVIDENCE,
      issues: [{ ...NO_EVIDENCE.issues[0], evidence: "bash: count => 4021" }],
    });
    expect(await h.gate.evaluate(h.makeDeps())).toBe("retry");
    expect(h.state.criticRepairCycles).toBe(1);
    expect(h.verdicts.at(-1)?.status).toBe("critical");
    expect(h.verdicts.at(-1)?.downgraded).toBeUndefined();
  });

  it("critic_check показывает улики: тул + ключевой аргумент", async () => {
    const h = makeHarness({ status: "ok", summary: "fine", issues: [] });
    await h.gate.evaluate(h.makeDeps());
    expect(h.checks.at(-1)?.evidence).toContain("read_file(src/a.ts)");
  });
});
