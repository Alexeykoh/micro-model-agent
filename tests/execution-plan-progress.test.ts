import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "fs";
import { ExecutionModule } from "../src/modules/execution/module";
import { createTestModule, cleanupTestModule } from "./plan-test-utils";

/**
 * ses_mt4fn58c plan-subsystem fixes:
 * - 4a: one progress counter — done+skipped are both settled steps; the old
 *   code said "6/7 done, complete" in `show` and "7/7" in `list` for the
 *   same plan (6 done + 1 skipped).
 * - 4b: action=update with steps[] silently rebuilt the whole plan,
 *   discarding all statuses — the model's bulk status rewrite was accepted
 *   and progress lost. Now rejected with guidance.
 * - 4c: update/show on an archived plan must say the plan is read-only
 *   instead of a bare "No active plan" loop anchor.
 */
describe("plan subsystem: progress counting + update guards", () => {
  let tmpDir: string;
  let mod: ExecutionModule;

  beforeEach(() => {
    tmpDir = createTestModule("mma-plan-fix-").tmpDir;
    mod = new ExecutionModule(tmpDir);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function planTool() {
    return mod.getToolDefinitions().find((t) => t.name === "plan")!;
  }

  async function createPlanWithSkippedStep() {
    const tool = planTool();
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Research options", "Configure tooling", "Write final summary"],
      checks: ["manual:verify Research options", "manual:verify Configure tooling", "manual:verify Write final summary"],
    });
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    await tool.handler(ctx, { action: "update", step: 2, status: "skipped" });
    return tool;
  }

  it("4a: counts skipped steps as settled consistently in show/list/update", async () => {
    const tool = await createPlanWithSkippedStep();
    const ctx: any = {};

    // Active-plan show: 2/3 settled (1 done + 1 skipped), not "1/3".
    const shown = await tool.handler(ctx, { action: "show" });
    expect(shown.output).toContain("2/3");

    // Completing the last step archives with the SAME count basis.
    const res = await tool.handler(ctx, { action: "update", step: 3, status: "done" });
    expect(res.output).toContain("3/3");
    const listed = await tool.handler(ctx, { action: "list" });
    expect(listed.output).toContain("3/3");
  });

  it("4b: rejects bulk steps[] rewrite instead of silently discarding statuses", async () => {
    await createPlanWithSkippedStep();
    const tool = planTool();
    const ctx: any = {};

    const res = await tool.handler(ctx, {
      action: "update",
      title: "T",
      steps: ["✅ Research options", "✅ Configure tooling", "Write final summary"],
      checks: ["manual:verify ✅ Research options", "manual:verify ✅ Configure tooling", "manual:verify Write final summary"],
    });
    expect(res.success).toBe(false);
    expect(res.output).toContain("re-plan");
    // The active plan is untouched.
    expect(mod.getTracker()!.getPlan().steps[0].status).toBe("done");
    expect(mod.getTracker()!.getPlan().steps[1].status).toBe("skipped");
  });

  it("4c: update by id on an archived plan says read-only, not 'No active plan'", async () => {
    const tool = await createPlanWithSkippedStep();
    const ctx: any = {};
    const id = mod.getTracker()!.getPlan().id;
    await tool.handler(ctx, { action: "update", step: 3, status: "done" }); // archive

    const res = await tool.handler(ctx, { action: "update", id, step: 3, status: "done" });
    expect(res.success).toBe(false);
    expect(res.output.toLowerCase()).toContain("archived");
    expect(res.output).not.toContain("No active plan");
  });
});
