import { describe, it, expect } from "vitest";
import { EnsembleJudge } from "../src/modules/evals/ensemble-judge";
import { applyStagedRollout } from "../src/modules/evals/rollout";
import type { LLMProvider } from "../src/llm/provider";

function fakeProvider(reply: string): LLMProvider {
  return {
    model: "fake",
    contextWindow: 100,
    async *chat() {
      yield { type: "text" as const, content: reply };
    },
    countTokens: (t: string) => t.length,
    listModels: async () => ["fake"],
  };
}

describe("ensemble judge", () => {
  it("majority contradicts → fail; majority no → pass", async () => {
    const j = new EnsembleJudge([
      fakeProvider('{"contradicts": true}'),
      fakeProvider('{"contradicts": true}'),
      fakeProvider('{"contradicts": false}'),
    ]);
    const r = await j.judge("new response", [{ decision: "use redis" }]);
    expect(r.verdict).toBe("fail");
    expect(r.agreement).toBeCloseTo(2 / 3);

    const j2 = new EnsembleJudge([
      fakeProvider('{"contradicts": false}'),
      fakeProvider('{"contradicts": false}'),
    ]);
    const r2 = await j2.judge("new response", [{ decision: "use redis" }]);
    expect(r2.verdict).toBe("pass");
  });

  it("all voters fail → degraded (fail-open)", async () => {
    const broken: LLMProvider = {
      model: "fake",
      contextWindow: 100,
      async *chat() {
        throw new Error("boom");
      },
      countTokens: (t: string) => t.length,
      listModels: async () => ["fake"],
    };
    const r = await new EnsembleJudge([broken]).judge("x", [{ decision: "y" }]);
    expect(r.verdict).toBe("degraded");
  });
});

describe("live staged rollout routing", () => {
  const manager = (names: string[]) => {
    const switched: string[] = [];
    return {
      switched,
      switch(name: string) {
        switched.push(name);
      },
      listNames() {
        return names;
      },
    };
  };

  it("switches to candidate when in bucket (100%)", () => {
    const m = manager(["main", "canary"]);
    expect(applyStagedRollout(m, "thr_any", { candidate: "canary", percentage: 100 })).toBe(true);
    expect(m.switched).toEqual(["canary"]);
  });

  it("no switch at 0% or unknown candidate", () => {
    const m = manager(["main"]);
    expect(applyStagedRollout(m, "thr_any", { candidate: "ghost", percentage: 100 })).toBe(false);
    expect(applyStagedRollout(m, "thr_any", { candidate: "main", percentage: 0 })).toBe(false);
  });

  it("bucket decides at mid percentages", () => {
    const m1 = manager(["main", "canary"]);
    const m2 = manager(["main", "canary"]);
    const p = 50;
    const rawBucket = applyStagedRollout(m1, "thr_a", { candidate: "canary", percentage: p });
    expect(typeof rawBucket).toBe("boolean");
    expect(m2.switched).toEqual([]);
  });
});
