import { describe, it, expect } from "vitest";
import { runFinalAudit, type FinalAuditHost } from "../../../src/modules/execution/final-audit";

function host(typecheckFailures: Map<string, string>): FinalAuditHost {
  return {
    baseDir: process.cwd(),
    tracker: null,
    completedPlan: null,
    auditor: {} as FinalAuditHost["auditor"],
    store: {} as FinalAuditHost["store"],
    auditSkipsRemaining: 0,
    mutatedThisTurn: true,
    typecheckFailures,
    setAuditSkipsRemaining: () => {},
    flushSessionPlan: () => {},
  };
}

describe("final typecheck gate without a plan", () => {
  it("fails the turn when a written file still has a type error", async () => {
    const r = await runFinalAudit(host(new Map([["src/a.ts", "TS2322: bad"]])));
    expect(r?.passed).toBe(false);
    expect(r?.summary).toContain("typecheck failed");
    expect(r?.pendingSteps[0]).toContain("src/a.ts");
  });

  it("does nothing when there are no known type errors", async () => {
    expect(await runFinalAudit(host(new Map()))).toBeNull();
  });
});
