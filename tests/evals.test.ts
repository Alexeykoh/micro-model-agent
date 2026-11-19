import { describe, it, expect } from "vitest";
import { buildScorecard, type CertEntryLike } from "../src/modules/evals/scorecard";
import { gradeTrajectory } from "../src/modules/evals/trajectory";

const ENTRY: CertEntryLike = {
  model: "m",
  providerUrl: "http://localhost:1234/v1",
  mmaVersion: "0.1.0",
  certifiedAt: "2026-11-09T00:00:00.000Z",
  suite: { passed: 3, failed: 1, skipped: 1, total: 5 },
  results: [
    { id: "security-bash", title: "s", status: "pass", passed: 1, of: 1 },
    { id: "2.1-read-file", title: "r", status: "fail", passed: 0, of: 1, error: "boom" },
    { id: "2.2-create-file", title: "c", status: "pass", passed: 1, of: 1 },
    { id: "2.3-create-dir-file", title: "d", status: "pass", passed: 1, of: 1 },
    { id: "2.4-edit-file", title: "e", status: "skip", passed: 0, of: 1 },
  ],
};

describe("evals scorecard", () => {
  it("aggregates passed/failed/safety", () => {
    const card = buildScorecard([ENTRY]);
    expect(card.passed).toBe(3);
    expect(card.failed).toBe(1);
    expect(card.skipped).toBe(1);
    expect(card.successRate).toBeCloseTo(0.6);
    expect(card.safetyFailures).toBe(0);
    expect(card.models[0].model).toBe("m");
    expect(card.scenarios).toBe(5);
  });

  it("counts safety scenario failures separately", () => {
    const card = buildScorecard([{ ...ENTRY, results: [...ENTRY.results, { id: "security-egress", title: "x", status: "fail", passed: 0, of: 1 }] }]);
    expect(card.safetyFailures).toBe(1);
  });
});

describe("trajectory checker", () => {
  const events = [
    { type: "tool_call", tool: "read_file" },
    { type: "tool_call", tool: "grep" },
    { type: "tool_result", tool: "grep", success: true },
    { role: "assistant", content: "final answer NEEDLE_A_111", success: true },
  ];

  it("passes when expectations met with order and needles", () => {
    const v = gradeTrajectory(events, {
      requiredTools: ["read_file", "grep"],
      forbiddenTools: ["bash"],
      order: ["read_file", "grep"],
      needlesInAnswer: ["NEEDLE_A_111"],
      maxToolFailures: 0,
    });
    expect(v.passed).toBe(true);
    expect(v.toolTrace).toEqual(["read_file", "grep"]);
  });

  it("fails on missing/order/needle/failures", () => {
    const v = gradeTrajectory(events, {
      requiredTools: ["bash"],
      forbiddenTools: ["grep"],
      order: ["grep", "read_file"],
      needlesInAnswer: ["OTHER"],
      maxToolFailures: 0,
    });
    expect(v.passed).toBe(false);
    expect(v.reasons.length).toBeGreaterThanOrEqual(4);
  });
});
