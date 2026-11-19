// Phase 2 harness-hardening: optional checks, actionable no_active, deferred archive.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExecutionModule } from "../src/modules/execution/module";
import { createTestModule, cleanupTestModule, writeTestFile } from "./plan-test-utils";

function planTool(m: ExecutionModule) {
  return m.getToolDefinitions().find((t) => t.name === "plan")!;
}
function planStepTool(m: ExecutionModule) {
  return m.getToolDefinitions().find((t) => t.name === "plan_step")!;
}

describe("plan checks are optional", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;
  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-harden-checks-"));
  });
  afterEach(() => cleanupTestModule(tmpDir));

  it("defaults checks to manual:<step> when omitted", async () => {
    const res = await planTool(execModule).handler(
      {},
      { action: "create", title: "T", steps: ["Create src/a.ts", "Verify styling"] },
    );
    expect(res.success).toBe(true);
    const steps = execModule.getTracker()!.getPlan().steps;
    expect(steps[0].check?.startsWith("manual:")).toBe(true);
    expect(steps[1].check?.startsWith("manual:")).toBe(true);
  });

  it("self-repairs a mismatch: keeps given checks, pads the rest with manual:", async () => {
    const res = await planTool(execModule).handler(
      {},
      { action: "create", title: "T", steps: ["a", "b"], checks: ["file-exists:a"] },
    );
    expect(res.success).toBe(true);
    const steps = execModule.getTracker()!.getPlan().steps;
    expect(steps[0].check).toBe("file-exists:a");
    expect(steps[1].check?.startsWith("manual:")).toBe(true);
  });

  it("non-code steps self-certify without false file checks", async () => {
    // Generality: a non-code task must not get file-exists contracts.
    const res = await planTool(execModule).handler(
      {},
      { action: "create", title: "Weather", steps: ["Fetch the forecast", "Write the answer in chat"] },
    );
    expect(res.success).toBe(true);
    for (const s of execModule.getTracker()!.getPlan().steps) {
      expect(s.check?.startsWith("manual:")).toBe(true);
      expect(s.check?.startsWith("file-exists:")).toBe(false);
    }
  });
});

describe("plan no_active is actionable", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;
  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-harden-noactive-"));
  });
  afterEach(() => cleanupTestModule(tmpDir));

  it("reports the last completed plan after auto-archive", async () => {
    await planTool(execModule).handler(
      {},
      {
        action: "create",
        title: "Build bikes",
        steps: ["Create src/a.ts"],
        checks: ["file-exists:src/a.ts"],
      },
    );
    writeTestFile(tmpDir, "src/a.ts");
    // Marking done via plan update auto-archives (model-driven path).
    const done = await planTool(execModule).handler({}, { action: "update", step: 1, status: "done" });
    expect(done.success).toBe(true);
    expect(execModule.getTracker()).toBeNull();
    const again = await planStepTool(execModule).handler({}, { step: 1, status: "done" });
    expect(again.success).toBe(false);
    expect(again.output).toContain("Build bikes");
  });
});

describe("execution.autoAdvance", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;
  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-harden-advance-"));
  });
  afterEach(() => cleanupTestModule(tmpDir));

  it("auto-advances and archives only at turn end", async () => {
    await planTool(execModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Create src/a.ts"],
        checks: ["file-exists:src/a.ts"],
      },
    );
    writeTestFile(tmpDir, "src/a.ts");
    const plugin = execModule.getPlugin();
    plugin.onAfterTool!(
      {},
      { name: "write_file", arguments: { path: "src/a.ts" }, id: "t1" },
      { success: true, output: "ok" },
    );
    // Step advanced, but plan not archived mid-turn.
    expect(execModule.getTracker()!.getPlan().steps[0].status).toBe("done");
    execModule.archiveCompletedPlan();
    expect(execModule.getTracker()).toBeNull();
    expect(execModule.getStore().listArchived().length).toBeGreaterThan(0);
  });

  it("keeps the step-gate nudge when autoAdvance is off", async () => {
    execModule.setAutoAdvance(false);
    await planTool(execModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Create src/a.ts"],
        checks: ["file-exists:src/a.ts"],
      },
    );
    writeTestFile(tmpDir, "src/a.ts");
    const plugin = execModule.getPlugin();
    plugin.onAfterTool!(
      {},
      { name: "write_file", arguments: { path: "src/a.ts" }, id: "t1" },
      { success: true, output: "ok" },
    );
    // Not auto-advanced.
    expect(execModule.getTracker()!.getPlan().steps[0].status).not.toBe("done");
    // But a nudge was queued for the model.
    const flushed: string[] = [];
    plugin.onBeforeThink!({
      contextManager: { addMessage: (m: { content: string }) => flushed.push(m.content) },
    });
    expect(flushed.join(" ")).toContain("plan_step");
  });
});
