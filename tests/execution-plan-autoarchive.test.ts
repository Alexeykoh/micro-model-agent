import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExecutionModule } from "../src/modules/execution/module";

function planTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

describe("plan auto-archive on completion", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-archive-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("archives the plan and clears tracker when the last step is marked done", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts", "Create src/b.ts"],
    });
    const planId = execModule.getTracker()!.getPlan().id;
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
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
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts"],
    });
    const planId = execModule.getTracker()!.getPlan().id;
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");

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
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, { action: "create", title: "T", steps: ["Create src/a.ts"] });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(execModule.getTracker()).toBeNull();

    const res = await tool.handler(ctx, { action: "create", title: "T2", steps: ["Create src/b.ts"] });
    expect(res.success).toBe(true);
    expect(execModule.getTracker()).not.toBeNull();
    expect(execModule.getTracker()!.getPlan().title).toContain("T2");
  });

  it("skipped-last-step plan is also auto-archived", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts", "Download images"],
    });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");

    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    const skip = await tool.handler(ctx, { action: "update", step: 2, status: "skipped" });
    expect(skip.success).toBe(true);
    expect(skip.output).toContain("archived");
    expect(execModule.getTracker()).toBeNull();
  });

  it("getSystemPromptBlock returns null after auto-archive", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, { action: "create", title: "T", steps: ["Create src/a.ts"] });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(execModule.getSystemPromptBlock()).toBeNull();
  });

  it("getPlanSummary returns null after auto-archive", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, { action: "create", title: "T", steps: ["Create src/a.ts"] });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(execModule.getPlanSummary()).toBeNull();
  });
});

describe("restorePlan archives complete plans", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-restore-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not restore a completed plan as active", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, { action: "create", title: "T", steps: ["Create src/a.ts"] });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    // Plan was auto-archived, active.json cleared. Restoring from disk finds
    // nothing — but even if a stale active.json somehow existed with a complete
    // plan, restorePlan should archive it rather than resurrect it.
    expect(execModule.getTracker()).toBeNull();
    expect(execModule.restorePlan()).toBe(false);
    expect(execModule.getTracker()).toBeNull();
  });
});
