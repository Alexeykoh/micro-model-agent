import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExecutionModule } from "../src/modules/execution/module";
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
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-abortid-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("aborts the plan given by id, not the active one", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    // Plan A becomes a draft when plan B is created over it (no progress).
    await tool.handler(ctx, { action: "create", title: "A", steps: ["Create src/a.ts"] });
    const aId = execModule.getTracker()!.getPlan().id;
    await tool.handler(ctx, { action: "create", title: "B", steps: ["Create src/b.ts"] });
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
    await tool.handler(ctx, { action: "create", title: "A", steps: ["Create src/a.ts"] });
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
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-switch-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is a no-op and does not duplicate the active plan", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, { action: "create", title: "A", steps: ["Create src/a.ts"] });
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
    await tool.handler(ctx, {
      action: "create",
      title: "A",
      steps: ["Create src/a.ts", "Create src/b.ts"],
    });
    const aId = execModule.getTracker()!.getPlan().id;
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    await tool.handler(ctx, { action: "abort" });

    await tool.handler(ctx, { action: "create", title: "B", steps: ["Create src/c.ts"] });
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
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-delete-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("permanently deletes an archived plan by id", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, { action: "create", title: "A", steps: ["Create src/a.ts"] });
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
    await tool.handler(ctx, { action: "create", title: "A", steps: ["Create src/a.ts"] });
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
    await tool.handler(ctx, { action: "create", title: "A", steps: ["Create src/a.ts"] });
    const aId = execModule.getTracker()!.getPlan().id;
    await tool.handler(ctx, { action: "abort" });
    // active B; A archived
    await tool.handler(ctx, { action: "create", title: "B", steps: ["Create src/b.ts"] });
    await tool.handler(ctx, { action: "abort" });
    // active C; B archived
    await tool.handler(ctx, { action: "create", title: "C", steps: ["Create src/c.ts"] });

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
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-completed-audit-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("audits the completed plan after plan update auto-archives it", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts with content", "Create src/b.ts with content"],
    });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
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
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts with content"],
    });
    // File never created — update is blocked by the deliverable gate, so mark
    // the step via the plugin's auto-advance? No — drive completion through
    // update with the file present, then delete the file before the audit.
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    rmSync(join(tmpDir, "src", "a.ts"));

    const audit = await execModule.runFinalAudit();
    expect(audit).not.toBeNull();
    expect(audit!.passed).toBe(false);
    expect(audit!.missingFiles).toContain("src/a.ts");
  });

  it("records the completed plan on the auto-advance path too", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts with content"],
    });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");

    // A successful write on the step file auto-completes the last step → the
    // plan auto-archives and clears the tracker.
    const plugin = execModule.getPlugin();
    const ctx2 = mockCtx();
    plugin.onAfterTool!(ctx2, { name: "write_file", arguments: { path: "src/a.ts" } } as any, {
      success: true,
      output: "Written src/a.ts",
    });
    expect(execModule.getTracker()).toBeNull();
    const audit = await execModule.runFinalAudit();
    expect(audit).not.toBeNull();
    expect(audit!.passed).toBe(true);
  });

  it("does not audit after abort (nothing completed)", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts with content"],
    });
    await tool.handler(ctx, { action: "abort" });
    expect(await execModule.runFinalAudit()).toBeNull();
  });
});

describe("evidence-based plan nudge (no bare iteration counters)", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-nudge-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
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
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, { action: "create", title: "T", steps: ["Create src/a.ts"] });
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
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-nodef-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("succeeds but notes that a file-less step cannot be auto-verified", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Run bun build and verify no errors"],
    });
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("names no files");
  });

  it("does not add the note when the step names real files", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts with content"],
    });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    const res = await tool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
    expect(res.output).not.toContain("names no files");
  });
});

describe("plan alignment ignores tool payload content", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-align-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not flag an on-track write whose content mentions other files", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts with content"],
    });
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
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-deps-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects the lockfile hint for a real install command without a lockfile", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["npm install express and start the server"],
    });
    const plugin = execModule.getPlugin();
    const ctx2 = mockCtx();
    plugin.onAfterTool!(ctx2, { name: "write_file", arguments: { path: "src/server.js" } } as any, {
      success: true,
      output: "ok",
    });
    const calls = ctx2.contextManager.addMessage.mock.calls.map((c: any[]) => String(c[0].content));
    expect(calls.some((c: string) => c.includes("dependencies are not installed"))).toBe(true);
  });

  it("does NOT treat a bare 'init'/'setup' step as a dependency install", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/index.ts with content"],
    });
    const plugin = execModule.getPlugin();
    const ctx2 = mockCtx();
    plugin.onAfterTool!(ctx2, { name: "write_file", arguments: { path: "src/index.ts" } } as any, {
      success: true,
      output: "ok",
    });
    const calls = ctx2.contextManager.addMessage.mock.calls.map((c: any[]) => String(c[0].content));
    expect(calls.some((c: string) => c.includes("dependencies are not installed"))).toBe(false);
  });
});

describe("auto-advance resolves nested step files (findExistingFile)", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plan-nested-adv-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("auto-advances when the step file lives in a nested project dir", async () => {
    const tool = planTool(execModule);
    const ctx: any = {};
    await tool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Create src/a.ts with content", "Create src/b.ts with content"],
    });
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
    tmpDir = mkdtempSync(join(tmpdir(), "mma-test-cmd-"));
  });

  afterEach(() => {
    if (rmSync) rmSync(tmpDir, { recursive: true, force: true });
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
