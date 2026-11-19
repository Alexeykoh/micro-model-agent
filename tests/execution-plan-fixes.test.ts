import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { ExecutionModule } from "../src/modules/execution/module";
import { createTestPlan, createTestModule, cleanupTestModule, writeTestFile } from "./plan-test-utils";
import { PlanCreator } from "../src/modules/execution/planner";
import { resolveTestCommand } from "../src/modules/execution/audit-runners";

function planTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

function mockCtx(overrides: Record<string, unknown> = {}) {
  return {
    contextManager: { addMessage: vi.fn() },
    sessionLog: { plan: vi.fn() },
    ...overrides,
  } as any;
}

describe("plan abort with id", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-abortid-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("aborts the plan given by id, not the active one", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    // Plan A becomes a draft when plan B is created over it (no progress).
    await createTestPlan(execModule, "A", ["Create src/a.ts"]);
    const aId = execModule.getTracker()!.getPlan().id;
    await createTestPlan(execModule, "B", ["Create src/b.ts"]);
    const bId = execModule.getTracker()!.getPlan().id;
    expect(execModule.getStore().find(aId)!.status).toBe("draft");

    // Old behavior ignored id and archived the ACTIVE plan (B). New: abort A.
    const res = await tool.handler(ctx, { action: "abort", id: aId });
    expect(res.success).toBe(true);
    expect(execModule.getStore().find(aId)!.status).toBe("archived");
    // B must remain the active plan.
    expect(execModule.getTracker()!.getPlan().id).toBe(bId);
  });

  it("fails on abort with a nonexistent id", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    const res = await tool.handler(ctx, { action: "abort", id: "plan_nope" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("not found");
  });

  it("fails on abort of an archived plan", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "Archived", ["Create src/archived.ts"]);
    const aId = execModule.getTracker()!.getPlan().id;
    await tool.handler(ctx, { action: "abort" });
    const res = await tool.handler(ctx, { action: "abort", id: aId });
    expect(res.success).toBe(false);
    expect(res.output).toContain("archived");
  });

  it("fails on abort with no active plan and no id", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    const res = await tool.handler(ctx, { action: "abort" });
    // Old behavior returned success:true on an empty plan list — the model
    // believed it aborted something. Must be an explicit failure now.
    expect(res.success).toBe(false);
    expect(res.output).toContain("No active plan");
  });
});

describe("plan switch to already-active plan", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-switch-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("is a no-op and does not duplicate the active plan", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "A", ["Create src/a.ts"]);
    const id = execModule.getTracker()!.getPlan().id;

    const res = await tool.handler(ctx, { action: "switch", id });
    expect(res.success).toBe(true);
    expect(res.output).toContain("already active");
    // Must be exactly one active plan with this id — no duplicate.
    const active = execModule
      .getStore()
      .listAll()
      .filter((m) => m.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(id);
    expect(execModule.getTracker()!.getPlan().id).toBe(id);
  });

  it("points 'current: step' at the first pending step after switching", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "A", ["Create src/a.ts", "Create src/b.ts"]);
    const aId = execModule.getTracker()!.getPlan().id;
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    await tool.handler(ctx, { action: "abort" });

    await createTestPlan(execModule, "B", ["Create src/c.ts"]);
    const res = await tool.handler(ctx, { action: "switch", id: aId });
    expect(res.success).toBe(true);
    expect(String(res.display)).toContain("current: step 2");
    expect(execModule.getTracker()!.getCurrentStep()!.id).toBe(2);
  });
});

describe("plan delete / purge", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-delete-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("permanently deletes an archived plan by id", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "Doomed", ["Create src/doomed.ts"]);
    const aId = execModule.getTracker()!.getPlan().id;
    await tool.handler(ctx, { action: "abort" });

    const res = await tool.handler(ctx, { action: "delete", id: aId });
    expect(res.success).toBe(true);
    expect(execModule.getStore().find(aId)).toBeNull();
    expect(execModule.getStore().listAll()).toHaveLength(0);
  });

  it("deleting the active plan clears the tracker", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "Active", ["Create src/active.ts"]);
    const aId = execModule.getTracker()!.getPlan().id;

    const res = await tool.handler(ctx, { action: "delete", id: aId });
    expect(res.success).toBe(true);
    expect(execModule.getTracker()).toBeNull();
  });

  it("fails when deleting a nonexistent id", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    const res = await tool.handler(ctx, { action: "delete" });
    expect(res.success).toBe(false);
  });

  it("purges all plans (active, drafts, archived)", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    // active A → aborted to archive
    await createTestPlan(execModule, "A", ["Create src/a.ts"]);
    const aId = execModule.getTracker()!.getPlan().id;
    await tool.handler(ctx, { action: "abort" });
    // active B; A archived
    await createTestPlan(execModule, "B", ["Create src/b.ts"]);
    await tool.handler(ctx, { action: "abort" });
    // active C; B archived
    await createTestPlan(execModule, "C", ["Create src/c.ts"]);

    expect(execModule.getStore().listAll().length).toBeGreaterThanOrEqual(3);
    const res = await tool.handler(ctx, { action: "purge" });
    expect(res.success).toBe(true);
    expect(execModule.getTracker()).toBeNull();
    expect(execModule.getStore().listAll()).toHaveLength(0);
    expect(execModule.getStore().find(aId)).toBeNull();
  });
});

describe("final audit still runs for a completed plan", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-completed-audit-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("audits the completed plan after plan update auto-archives it", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts with content", "Create src/b.ts with content"]);
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    writeFileSync(join(tmpDir, "src", "b.ts"), "export const b = 1;\n");

    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    await tool.handler(ctx, { action: "update", step: 2, status: "done" });

    // Tracker cleared by the auto-archive…
    expect(execModule.getTracker()).toBeNull();
    // …but the final audit must still run (previously returned null).
    const audit = await execModule.runFinalAudit();
    expect(audit).not.toBeNull();
    expect(audit!.passed).toBe(true);
    expect(audit!.done).toBe(2);
  });

  it("fails the completed-plan audit when a named file is missing", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts with content"]);
    // File never created — update is blocked by the deliverable gate, so mark
    // the step via the plugin's auto-advance? No — drive completion through
    // update with the file present, then delete the file before the audit.
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    rmSync(join(tmpDir, "src", "a.ts"));

    const audit = await execModule.runFinalAudit();
    expect(audit).not.toBeNull();
    expect(audit!.passed).toBe(false);
    expect(audit!.missingFiles).toContain("src/a.ts");
  });

  it("auto-closes pending steps whose named files all exist (evidence-based)", async () => {
await createTestPlan(execModule, "T", ["Create src/a.ts with content", "Create src/b.ts with content"]);
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    writeFileSync(join(tmpDir, "src", "b.ts"), "export const b = 2;\n");

    // The model never called plan update — the audit itself must recognize
    // the deliverables and close the steps instead of rejecting the answer.
    const audit = await execModule.runFinalAudit();
    expect(audit).not.toBeNull();
    expect(audit!.passed).toBe(true);
    expect(audit!.done).toBe(2);
    const steps = execModule.getTracker()!.getPlan().steps;
    for (const s of steps) {
      expect(s.status).toBe("done");
      expect(s.note).toContain("auto-closed");
    }
  });

  it("does not auto-close a create step whose file exists but is empty", async () => {
await createTestPlan(execModule, "T", ["Create src/a.ts with content"]);
    writeTestFile(tmpDir, "src/a.ts", "   \n");

    const audit = await execModule.runFinalAudit();
    expect(audit).not.toBeNull();
    expect(audit!.done).toBe(0);
    expect(audit!.pendingSteps).toHaveLength(1);
  });

  it("does not auto-close a delete step while its target still exists", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Delete src/a.ts"],
      checks: ["file-exists:src/a.ts"],
      kinds: ["delete"],
    });
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");

    const audit = await execModule.runFinalAudit();
    expect(audit!.done).toBe(0);
    expect(audit!.pendingSteps).toHaveLength(1);
  });

  it("auto-closes a delete step once its target is gone", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Delete src/a.ts"],
      checks: ["file-exists:src/a.ts"],
      kinds: ["delete"],
    });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const target = join(tmpDir, "src", "a.ts");
    writeFileSync(target, "export const a = 1;\n");
    rmSync(target);

    await execModule.runFinalAudit();
    const steps = execModule.getTracker()!.getPlan().steps;
    expect(steps[0].status).toBe("done");
    expect(steps[0].note).toContain("removed");
  });

  it("keeps pending steps with no evidence (file missing or no file token)", async () => {
await createTestPlan(execModule, "T", ["Create src/missing.ts with content", "Review the overall approach"]);
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    const audit = await execModule.runFinalAudit();
    expect(audit).not.toBeNull();
    expect(audit!.passed).toBe(false);
    // src/missing.ts does not exist → step stays pending; the file-less step
    // stays pending too (nothing to verify against).
    expect(audit!.done).toBe(0);
    expect(audit!.pendingSteps).toHaveLength(2);
  });

  it("records the completed plan on the auto-advance path too", async () => {
await createTestPlan(execModule, "T", ["Create src/a.ts with content"]);
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");

    // A successful write on the step file auto-completes the last step; the
    // plan is archived at the turn boundary, which records it for the audit.
    const plugin = execModule.getPlugin();
    const ctx2 = mockCtx();
    plugin.onAfterTool!(ctx2, { name: "write_file", arguments: { path: "src/a.ts" } } as any, {
      success: true,
      output: "Written src/a.ts",
    });
    expect(execModule.getTracker()).not.toBeNull();
    execModule.archiveCompletedPlan();
    expect(execModule.getTracker()).toBeNull();
    const audit = await execModule.runFinalAudit();
    expect(audit).not.toBeNull();
    expect(audit!.passed).toBe(true);
  });

  it("does not audit after abort (nothing completed)", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts with content"]);
    await tool.handler(ctx, { action: "abort" });
    expect(await execModule.runFinalAudit()).toBeNull();
  });
});

describe("evidence-based plan nudge (no bare iteration counters)", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-nudge-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("nudges for a plan only after file-mutating calls without one", async () => {
    const plugin = execModule.getPlugin();
    const ctx = mockCtx({ iteration: 5 });

    // Read-only calls must NOT count toward the nudge.
    plugin.onToolCall!({ toolName: "read_file", args: { path: "src/a.ts" } });
    plugin.onBeforeThink!(ctx);
    expect(ctx.contextManager.addMessage).not.toHaveBeenCalled();

    // Two file-mutating calls without a plan → nudge on the next think.
    plugin.onToolCall!({ toolName: "write_file", args: { path: "src/a.ts" } });
    plugin.onToolCall!({ toolName: "bash", args: { command: "bun add dep" } });
    plugin.onBeforeThink!(ctx);
    const calls = ctx.contextManager.addMessage.mock.calls.map((c: any[]) => String(c[0].content));
    expect(calls.some((c: string) => c.includes("without a plan"))).toBe(true);

    // Fires once — a repeat think with no new mutations must not re-inject.
    ctx.contextManager.addMessage.mockClear();
    plugin.onBeforeThink!(ctx);
    expect(ctx.contextManager.addMessage).not.toHaveBeenCalled();
  });

  it("resets the mutation counter once a plan exists", async () => {
await createTestPlan(execModule, "T", ["Create src/a.ts"]);
    const plugin = execModule.getPlugin();
    const thinkCtx = mockCtx();
    plugin.onToolCall!({ toolName: "write_file", args: { path: "src/a.ts" } });
    plugin.onBeforeThink!(thinkCtx);
    expect(thinkCtx.contextManager.addMessage).not.toHaveBeenCalled();
  });
});

describe("plan update notes for command-only steps", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-nodef-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("stays silent on file-less steps in a pure non-code plan", async () => {
    // Changed behavior (fix/no-unsolicited-artifacts): a plan with no file
    // steps at all is a non-code task (research/advice) — the vacuous-gate
    // note must not fire and push the model to materialize files or run
    // build/tests. Mixed plans still get the neutral note (see
    // execution-plan-deliverables.test.ts).
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Run bun build and verify no errors"]);
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
    expect(res.output).not.toContain("names no files");
  });

  it("does not add the note when the step names real files", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "T", ["Create src/a.ts with content"]);
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
    expect(res.output).not.toContain("names no files");
  });
});

describe("plan alignment ignores tool payload content", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-align-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("does not flag an on-track write whose content mentions other files", async () => {
await createTestPlan(execModule, "T", ["Create src/a.ts with content"]);
    const plugin = execModule.getPlugin();
    const onTrack = {
      name: "write_file",
      arguments: {
        path: "src/a.ts",
        content:
          'import "./styles.css"\nimport { helper } from "../lib/util.ts"\nexport const x = 1;\n',
      },
    } as any;
    // Old behavior JSON-stringified the whole args blob, so `styles.css` and
    // `util.ts` inside the CONTENT produced phantom off-path warnings.
    for (let i = 0; i < 3; i++) {
      expect(plugin.onBeforeTool!(mockCtx(), onTrack)).toBe(true);
    }
  });
});

describe("deps-step gate uses package-manager verbs, not bare keywords", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-deps-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("injects the lockfile hint for a real install command without a lockfile", async () => {
await createTestPlan(execModule, "T", ["npm install express and start the server"]);
    const plugin = execModule.getPlugin();
    const ctx2 = mockCtx();
    plugin.onAfterTool!(ctx2, { name: "write_file", arguments: { path: "src/server.js" } } as any, {
      success: true,
      output: "ok",
    });
    // Step-gate сообщения деферятся до следующего THINK (не вклиниваются между
    // assistant(tool_calls) и tool-результатами) — flush на onBeforeThink.
    plugin.onBeforeThink!(ctx2);
    const calls = ctx2.contextManager.addMessage.mock.calls.map((c: any[]) => String(c[0].content));
    expect(calls.some((c: string) => c.includes("dependencies are not installed"))).toBe(true);
  });

  it("does NOT treat a bare 'init'/'setup' step as a dependency install", async () => {
await createTestPlan(execModule, "T", ["Create src/index.ts with content"]);
    const plugin = execModule.getPlugin();
    const ctx2 = mockCtx();
    plugin.onAfterTool!(ctx2, { name: "write_file", arguments: { path: "src/index.ts" } } as any, {
      success: true,
      output: "ok",
    });
    plugin.onBeforeThink!(ctx2);
    const calls = ctx2.contextManager.addMessage.mock.calls.map((c: any[]) => String(c[0].content));
    expect(calls.some((c: string) => c.includes("dependencies are not installed"))).toBe(false);
  });
});

describe("auto-advance resolves nested step files (findExistingFile)", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-nested-adv-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("auto-advances when the step file lives in a nested project dir", async () => {
await createTestPlan(execModule, "T", ["Create src/a.ts with content", "Create src/b.ts with content"]);
    // Real file at baseDir/bicycle-shop/src/a.ts (nested project).
    mkdirSync(join(tmpDir, "bicycle-shop", "src"), { recursive: true });
    writeFileSync(join(tmpDir, "bicycle-shop", "src", "a.ts"), "export const a = 1;\n");

    const plugin = execModule.getPlugin();
    const ctx2 = mockCtx();
    plugin.onAfterTool!(ctx2, { name: "write_file", arguments: { path: "src/a.ts" } } as any, {
      success: true,
      output: "Written src/a.ts",
    });
    // Old exact-resolve path could not see the nested file → step stayed pending.
    expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
    expect(execModule.getTracker()!.getCurrentStep()!.id).toBe(2);
  });
});

describe("replan renumbers ids without collisions", () => {
  it("keeps done/skipped steps and assigns sequential ids to kept + new", () => {
    const plan = PlanCreator.createPlan("T", ["step 1", "step 2", "step 3", "step 4"], "/test/dir");
    plan.steps[0].status = "done";
    plan.steps[2].status = "done"; // step 3 done, step 2 still pending → dropped
    const replanned = PlanCreator.replan(plan, ["new step"]);
    // kept: step1(done), step3(done) → ids must be 1,2,3 — no collision with
    // the original "3" (old code: kept id 3 collided with added id 3).
    const ids = replanned.steps.map((s) => s.id);
    expect(ids).toEqual([1, 2, 3]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(replanned.steps[0].status).toBe("done");
    expect(replanned.steps[2].description).toBe("new step");
  });
});

describe("resolveTestCommand picks the project's runner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTestModule("mma-test-cmd-").tmpDir;
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("falls back to bun test without a manifest", () => {
    expect(resolveTestCommand(tmpDir)).toBe("bun test");
  });

  it("uses package.json scripts.test when present", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    expect(resolveTestCommand(tmpDir)).toBe("vitest run");
  });

  it("detects vitest config files", () => {
    writeFileSync(join(tmpDir, "vitest.config.ts"), "export default {}");
    expect(resolveTestCommand(tmpDir)).toBe("bunx vitest run");
  });

  it("detects python projects", () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), "[project]");
    expect(resolveTestCommand(tmpDir)).toBe("python -m pytest -q");
  });

  it("detects go projects", () => {
    writeFileSync(join(tmpDir, "go.mod"), "module test");
    expect(resolveTestCommand(tmpDir)).toBe("go test ./...");
  });
});

describe("plan update status validation", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-plan-status-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("rejects an unknown status and leaves the step untouched", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "A", ["Create src/a.ts"]);

    const res = await tool.handler(ctx, { action: "update", step: 1, status: "completed" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("Invalid status");
    // Bogus value must not be persisted as the step status.
    expect(execModule.getTracker()!.getStep(1)!.status).toBe("pending");
  });

  it("rejects re-opening a done step with status=pending", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await createTestPlan(execModule, "A", ["Create src/a.ts", "Create src/b.ts"]);
    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");

    const res = await tool.handler(ctx, { action: "update", step: 1, status: "pending" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("Invalid status");
    expect(execModule.getTracker()!.getStep(1)!.status).toBe("done");
  });
});
