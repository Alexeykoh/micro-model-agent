import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import { StepVerifier } from "../src/modules/execution/verifier";
import { StuckDetector } from "../src/modules/execution/stuck-detector";
import type { ExecutionModule } from "../src/modules/execution/module";
import { createTestModule, cleanupTestModule } from "./plan-test-utils";

// ── verifyStep delete semantics ──────────────────────────────────────
describe("StepVerifier — delete semantics", () => {
  let tmpDir: string;
  let verifier: StepVerifier;

  beforeEach(() => {
    tmpDir = createTestModule("mma-verify-delete-").tmpDir;
    verifier = new StepVerifier(tmpDir);
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("create step: file missing → fail", async () => {
    const r = await verifier.verifyStep("Create foo.txt");
    expect(r.passed).toBe(false);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].message).toContain("foo.txt");
  });

  it("create step: file exists → pass", async () => {
    writeFileSync(join(tmpDir, "foo.txt"), "hi");
    const r = await verifier.verifyStep("Create foo.txt");
    expect(r.passed).toBe(true);
    expect(r.failed.length).toBe(0);
  });

  it("delete step: file gone → pass", async () => {
    const r = await verifier.verifyStep("Delete old.txt", "delete");
    expect(r.passed).toBe(true);
    expect(r.failed.length).toBe(0);
  });

  it("delete step: file still exists → fail", async () => {
    writeFileSync(join(tmpDir, "old.txt"), "stale");
    const r = await verifier.verifyStep("Delete old.txt", "delete");
    expect(r.passed).toBe(false);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].message).toContain("old.txt");
  });

  it("delete step: no file tokens → noFiles", async () => {
    const r = await verifier.verifyStep("Clean up the codebase", "delete");
    expect(r.noFiles).toBe(true);
  });

  it("delete step: does not run syntax check on deleted file", async () => {
    // If syntax check ran on a non-existent file it would fail — but delete
    // skips it, so the result should pass cleanly.
    const r = await verifier.verifyStep("Delete temp.ts", "delete");
    expect(r.passed).toBe(true);
    expect(r.syntaxValid).toBe(true);
  });
});

// ── StuckDetector iteration decay ────────────────────────────────────
describe("StuckDetector — recordToolSuccess decay", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("does not decay below zero", () => {
    expect(detector.getIterationsOnCurrentStep()).toBe(0);
    detector.recordToolSuccess();
    expect(detector.getIterationsOnCurrentStep()).toBe(0);
  });

  it("decays iterations by 1 per successful call", () => {
    detector.setCurrentStep(1, "step");
    // setCurrentStep → resetStepState(1) → iterationsOnCurrentStep = 1
    // recordIteration(1) × 3 → increments to 4
    for (let i = 0; i < 3; i++) detector.recordIteration(1);
    expect(detector.getIterationsOnCurrentStep()).toBe(4);

    detector.recordToolSuccess();
    expect(detector.getIterationsOnCurrentStep()).toBe(3);
    detector.recordToolSuccess();
    expect(detector.getIterationsOnCurrentStep()).toBe(2);
  });

  it("can bring counter below stuck threshold so isStuck resets", () => {
    detector.setCurrentStep(1, "step");
    // resetStepState → 1, then recordIteration × 5 → 6
    for (let i = 0; i < 5; i++) detector.recordIteration(1);
    expect(detector.isStuck()).toBe(true);

    // 3 productive calls bring iterations from 6 → 3, below threshold 5
    detector.recordToolSuccess();
    detector.recordToolSuccess();
    detector.recordToolSuccess();
    expect(detector.getIterationsOnCurrentStep()).toBe(3);
    expect(detector.isStuck()).toBe(false);
  });

  it("multiple successful calls eventually reach zero", () => {
    detector.setCurrentStep(1, "step");
    // resetStepState → 1, then recordIteration × 4 → 5
    for (let i = 0; i < 4; i++) detector.recordIteration(1);
    for (let i = 0; i < 10; i++) detector.recordToolSuccess();
    expect(detector.getIterationsOnCurrentStep()).toBe(0);
  });
});

// ── auto-detect delete kind (onAfterTool logic) ─────────────────────
describe("auto-detect delete kind from delete_file call", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;
  let plugin: any;

  beforeEach(async () => {
    tmpDir = createTestModule("mma-delete-auto-").tmpDir;
    const { ExecutionModule: EM } = await import("../src/modules/execution/module");
    execModule = new EM(tmpDir, 8);
    plugin = execModule.getPlugin();
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("sets kind=delete on matching step when delete_file succeeds", async () => {
    const planTool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
    await planTool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Delete old.ts", "Create new.ts"],
        checks: ["file-exists:old.ts", "file-exists:new.ts"],
      },
    );

    // Simulate a successful delete_file call
    plugin.onAfterTool(
      {},
      { name: "delete_file", id: "tc1", arguments: { path: "old.ts" } },
      { success: true, output: "Deleted old.ts" },
    );

    const plan = execModule.getTracker()!.getPlan();
    expect(plan.steps[0].kind).toBe("delete");
    expect(plan.steps[1].kind).toBe("create"); // default kind, untouched by auto-detect
  });

  it("does not set kind when delete_file fails", async () => {
    const planTool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
    await planTool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Delete old.ts"],
        checks: ["file-exists:old.ts"],
      },
    );

    plugin.onAfterTool(
      {},
      { name: "delete_file", id: "tc1", arguments: { path: "old.ts" } },
      { success: false, output: "Permission denied" },
    );

    const plan = execModule.getTracker()!.getPlan();
    expect(plan.steps[0].kind).toBe("create"); // default, not changed by failed delete
  });

  it("does not set kind on non-matching steps", async () => {
    const planTool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
    await planTool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Update readme.md", "Delete old.ts"],
        checks: ["file-exists:readme.md", "file-exists:old.ts"],
      },
    );

    plugin.onAfterTool(
      {},
      { name: "delete_file", id: "tc1", arguments: { path: "old.ts" } },
      { success: true, output: "Deleted old.ts" },
    );

    const plan = execModule.getTracker()!.getPlan();
    expect(plan.steps[0].kind).toBe("create"); // no match — stays default
    expect(plan.steps[1].kind).toBe("delete");
  });

  it("auto-detect overrides the default kind on delete_file (behavior over declaration)", async () => {
    const planTool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
    await planTool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Delete old.ts", "Create new.ts"],
        checks: ["file-exists:old.ts", "file-exists:new.ts"],
      },
    );
    expect(execModule.getTracker()!.getStep(1)!.kind).not.toBe("delete");

    plugin.onAfterTool(
      {},
      { name: "delete_file", id: "tc1", arguments: { path: "old.ts" } },
      { success: true, output: "Deleted old.ts" },
    );

    const plan = execModule.getTracker()!.getPlan();
    // kinds are no longer model-declared (removed from the plan schema) —
    // what the agent DID (delete_file) wins over the default.
    expect(plan.steps[0].kind).toBe("delete");
  });

  it("ignores done steps (only processes pending/in_progress)", async () => {
    const planTool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
    const ctx: any = {};
    // 2-step plan with explicit kinds: step 1 is delete, step 2 is create
    await planTool.handler(ctx, {
      action: "create",
      title: "T",
      steps: ["Delete old.ts", "Create new.ts"],
      checks: ["file-exists:old.ts", "file-exists:new.ts"],
      kinds: ["delete", "create"],
    });
    // Mark step 1 done — file doesn't exist, but kind="delete" inverts the gate
    const updateResult = await planTool.handler(ctx, { action: "update", step: 1, status: "done" });
    expect(updateResult.success).toBe(true);

    // delete_file matches "old.ts" — step 1 (done) should NOT change kind
    plugin.onAfterTool(
      ctx,
      { name: "delete_file", id: "tc1", arguments: { path: "old.ts" } },
      { success: true, output: "Deleted old.ts" },
    );

    const plan = execModule.getTracker()!.getPlan();
    // Step 1 is done — auto-detect skips it, kind stays "delete" (explicit)
    expect(plan.steps[0].kind).toBe("delete");
    // Step 2 is pending but doesn't match "old.ts" — stays "create"
    expect(plan.steps[1].kind).toBe("create");
  });

  it("ignores non-delete_file tools", async () => {
    const planTool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
    await planTool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Delete old.ts"],
        checks: ["file-exists:old.ts"],
      },
    );

    plugin.onAfterTool(
      {},
      { name: "edit_file", id: "tc1", arguments: { path: "old.ts" } },
      { success: true, output: "Edited old.ts" },
    );

    const plan = execModule.getTracker()!.getPlan();
    expect(plan.steps[0].kind).toBe("create"); // edit_file, not delete_file
  });

  it("matches via path suffix (nested path in delete_file)", async () => {
    const planTool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
    await planTool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Delete src/utils/old.ts"],
        checks: ["file-exists:src/utils/old.ts"],
      },
    );

    plugin.onAfterTool(
      {},
      { name: "delete_file", id: "tc1", arguments: { path: "src/utils/old.ts" } },
      { success: true, output: "Deleted src/utils/old.ts" },
    );

    // Since auto-advance covers delete_file (fs-mutating), the kind switch
    // ALSO completes the step: the only deliverable is gone → done. The plan
    // is archived at the turn boundary, not mid-turn (tracker still present).
    expect(execModule.getTracker()).not.toBeNull();
    expect(execModule.getTracker()!.getPlan().steps[0].kind).toBe("delete");
    execModule.archiveCompletedPlan();
    expect(execModule.getTracker()).toBeNull();
    const archived = execModule.getStore().listArchived().at(-1);
    expect(archived).toBeDefined();
    expect(archived!.steps[0].kind).toBe("delete");
  });
});
