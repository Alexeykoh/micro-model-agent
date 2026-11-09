import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { gradeTrajectory, type TrajectoryExpectations } from "../src/modules/evals/trajectory";
import { rolloutBucket, inRollout, rolloutMode } from "../src/modules/evals/rollout";

interface GoldTrace {
  id: string;
  events: Array<Record<string, unknown>>;
  expect: TrajectoryExpectations & { verdict: "pass" | "fail" };
}

describe("human-gold eval fixtures", () => {
  it("all gold traces grade to their expected verdicts", () => {
    const raw = JSON.parse(readFileSync(new URL("./evals/gold-v1.json", import.meta.url), "utf-8")) as {
      traces: GoldTrace[];
    };
    expect(raw.traces.length).toBeGreaterThanOrEqual(3);
    for (const g of raw.traces) {
      const expected: TrajectoryExpectations = {
        requiredTools: g.expect.requiredTools,
        forbiddenTools: g.expect.forbiddenTools,
        order: g.expect.order,
        needlesInAnswer: g.expect.needlesInAnswer,
        maxToolFailures: g.expect.maxToolFailures,
      };
      const verdict = gradeTrajectory(
        g.events as Parameters<typeof gradeTrajectory>[0],
        expected,
      );
      expect(verdict.passed, `${g.id} → ${verdict.reasons.join("; ")}`).toBe(g.expect.verdict === "pass");
    }
  });
});

describe("staged rollout bucketing", () => {
  it("is stable and bounded", () => {
    const b = rolloutBucket("thr_0123456789abcdef");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(100);
    expect(rolloutBucket("thr_0123456789abcdef")).toBe(b);
  });
  it("boundary behaviour", () => {
    expect(inRollout("anything", 0)).toBe(false);
    expect(inRollout("anything", 100)).toBe(true);
    expect(inRollout("anything", -5)).toBe(false);
    expect(inRollout("anything", Number.NaN)).toBe(false);
  });
  it("modes", () => {
    expect(rolloutMode(0)).toBe("shadow");
    expect(rolloutMode(5)).toBe("canary");
    expect(rolloutMode(50)).toBe("percentage");
    expect(rolloutMode(100)).toBe("full");
  });
});
