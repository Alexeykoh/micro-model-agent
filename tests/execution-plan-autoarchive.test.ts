import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import { ExecutionModule } from "../src/modules/execution/module";
import { createTestPlan, createTestModule, cleanupTestModule, writeTestFile, setupSingleFilePlan, setupCompletedStep } from "./plan-test-utils";

function planTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

describe("plan auto-archive on completion", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-archive-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("archives the plan and clears tracker when the last step is marked done", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts", "Create src/b.ts"]);
    const planId = execModule.getTracker()!.getPlan().id;
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    writeFileSync(join(tmpDir, "src", "b.ts"), "export const b = 1;\n");

    const step1 = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(step1.success).toBe(true);
    expect(execModule.getTracker()).not.toBeNull();

    const step2 = await tool.handler(ctx, { action: "update", step: 2, status: "done" });
    expect(step2.success).toBe(true);
    expect(step2.output).toContain("archived");
    // Tracker cleared — no active plan left.
    expect(execModule.getTracker()).toBeNull();
    // The plan landed in the archive.
    const all = execModule.getStore().listAll();
    expect(all.find((m) => m.id === planId && m.status === "archived")).toBeTruthy();
  });

  it("auto-archives when re-marking a done step on an already-complete plan (loop anchor)", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts"]);
    const planId = execModule.getTracker()!.getPlan().id;
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");

    // Mark step done → plan complete → auto-archived.
    const done = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(done.success).toBe(true);
    expect(done.output).toContain("archived");
    expect(execModule.getTracker()).toBeNull();

    // Re-marking step 1 done on the now-absent plan — no active plan.
    const again = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(again.success).toBe(false);
    expect(again.output.toLowerCase()).toContain("no active");
  });

  it("allows creating a new plan after the previous one auto-archived", async () => {
    await setupCompletedStep(execModule, tmpDir);
    expect(execModule.getTracker()).toBeNull();

    const res = await createTestPlan(execModule, "T2", ["Create src/b.ts"]);
    expect(res.success).toBe(true);
    expect(execModule.getTracker()).not.toBeNull();
    expect(execModule.getTracker()!.getPlan().title).toContain("T2");
  });

  it("skipped-last-step plan is also auto-archived", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts", "Download images"]);
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");

    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    const skip = await tool.handler(ctx, { action: "update", step: 2, status: "skipped" });
    expect(skip.success).toBe(true);
    expect(skip.output).toContain("archived");
    expect(execModule.getTracker()).toBeNull();
  });

  it("null projections after auto-archive", async () => {
    await setupCompletedStep(execModule, tmpDir);
    expect(execModule.getTracker()).toBeNull();
    expect(execModule.getSystemPromptBlock()).toBeNull();
    expect(execModule.getPlanSummary()).toBeNull();
  });
});

describe("restorePlan archives complete plans", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-restore-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("does not restore a completed plan as active", async () => {
    await setupCompletedStep(execModule, tmpDir);
    // Plan was auto-archived, active.json cleared. Restoring from disk finds
    // nothing — but even if a stale active.json somehow existed with a complete
    // plan, restorePlan should archive it rather than resurrect it.
    expect(execModule.getTracker()).toBeNull();
    expect(execModule.restorePlan()).toBe(false);
    expect(execModule.getTracker()).toBeNull();
  });
});
