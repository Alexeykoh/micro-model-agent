import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StuckDetector } from "../src/modules/execution/stuck-detector";
import { PlanCreator } from "../src/modules/execution/planner";
import { PlanTracker } from "../src/modules/execution/tracker";
import { ExecutionModule } from "../src/modules/execution/module";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

function mockCtx(): any {
  return {
    contextManager: {
      addMessage: (_msg: any) => {},
    },
    iteration: 1,
    logger: { warn: () => {} },
  };
}

function mockResult(overrides: any = {}): any {
  return { success: true, output: "ok", ...overrides };
}

function mockToolCall(overrides: any = {}): any {
  return { id: "call-1", name: "write_file", arguments: {}, ...overrides };
}

const TEST_DIR = "/test/plan";

function mkPlan(title: string, steps: string[]) {
  return PlanCreator.createPlan(title, steps, TEST_DIR);
}

describe("StuckDetector - recovery with step context", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("recovery message includes stepId and description when stuck", () => {
    detector.setCurrentStep(3, "Установка зависимостей через npm install");
    for (let i = 0; i < 6; i++) {
      detector.recordIteration(3);
    }
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toContain("3");
    expect(recovery).toContain("Установка зависимостей");
  });

  it("recovery message includes stepId even when currentStepId is null", () => {
    for (let i = 0; i < 6; i++) {
      detector.recordIteration(1);
    }
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toContain("has had no progress");
  });

  it("tool errors recovery message is still generated", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolError("npm");
    }
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toBeTruthy();
    expect(recovery).toContain("npm");
    expect(recovery).toContain("write_file");
  });

  it("consecutive failures recovery message is generated", () => {
    detector.recordToolError("bash");
    detector.recordToolError("bash");
    detector.recordToolError("bash");
    detector.recordToolError("git");
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toBeTruthy();
  });

  it("repetitive tool calls recovery mentions the tool", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolCall("bash", { cmd: "dir", workdir: "." });
    }
    expect(detector.hasRepetitiveToolCalls()).toBe(true);
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toContain("bash");
  });

  it("stuck reason includes step description", () => {
    detector.setCurrentStep(2, "create src/main.tsx and src/App.tsx");
    for (let i = 0; i < 6; i++) {
      detector.recordIteration(2);
    }
    const reason = detector.getStuckReason();
    expect(reason).toContain("2");
    expect(reason).toContain("create src/main.tsx");
  });
});

describe("PlanTracker - auto-advance without step gate", () => {
  it("advances to next step and marks current as in_progress", () => {
    const plan = mkPlan("Test", [
      "Create index.html in public dir",
      "Create src/main.ts with entry point",
    ]);
    const tracker = new PlanTracker(plan);
    const step1 = tracker.getCurrentStep();
    expect(step1?.id).toBe(1);
    expect(step1?.status).toBe("pending");

    tracker.updateStepStatus(1, "done");
    const advanced = tracker.advance();
    expect(advanced).toBe(true);

    const step2 = tracker.getCurrentStep();
    expect(step2?.id).toBe(2);
    expect(step2?.status).toBe("in_progress");
  });

  it("does not advance past last step", () => {
    const plan = mkPlan("Test", ["Step 1"]);
    const tracker = new PlanTracker(plan);
    tracker.updateStepStatus(1, "done");
    const advanced = tracker.advance();
    expect(advanced).toBe(false);
  });

  it("shows correct progress string", () => {
    const plan = mkPlan("Build App", ["Init project", "Add components", "Add tests"]);
    const tracker = new PlanTracker(plan);
    tracker.updateStepStatus(1, "done");
    const progress = tracker.getProgressString();
    expect(progress).toContain("Build App");
    expect(progress).toContain("1/3");
  });
});

describe("PlanCreator - prompt block format", () => {
  it("renders steps with correct icons", () => {
    const plan = mkPlan("Test Plan", ["Step one", "Step two", "Step three"]);
    plan.steps[0].status = "done";
    plan.steps[1].status = "in_progress";
    const block = PlanCreator.toPromptBlock(plan, 1);
    expect(block).toContain("[x]");
    expect(block).toContain("[*]");
    expect(block).toContain("[ ]");
    expect(block).toContain("Test Plan");
    expect(block).toContain("step 2");
  });

  it("shows failed and skipped statuses", () => {
    const plan = mkPlan("Test", ["A", "B", "C"]);
    plan.steps[0].status = "failed";
    plan.steps[1].status = "skipped";
    plan.steps[2].status = "done";
    const block = PlanCreator.toPromptBlock(plan, 0);
    expect(block).toContain("[!]");
    expect(block).toContain("[-]");
  });
});

describe("Scenario: Progressive plan enforcement", () => {
  let execModule: ExecutionModule;
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `mma-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    execModule = new ExecutionModule(tempDir, 8);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup — best effort */
    }
  });

  it("creates a plan and tracks steps", () => {
    execModule.setPlan(mkPlan("Test", ["create src/index.ts with content", "create src/utils.ts"]));
    const tracker = execModule.getTracker();
    expect(tracker).not.toBeNull();
    expect(tracker!.getCurrentStep()?.id).toBe(1);
  });

  it("restores a plan from disk", () => {
    execModule.setPlan(mkPlan("Test Restore", ["create file-a.ts", "create file-b.ts"]));
    // Mark step 1 done and advance tracker
    execModule.getTracker()!.updateStepStatus(1, "done");
    execModule.getTracker()!.advance();
    // Write updated plan to disk so restorePlan picks it up
    const plan = execModule.getTracker()!.getPlan();
    mkdirSync(join(tempDir, ".mma", "plans"), { recursive: true });
    writeFileSync(join(tempDir, ".mma", "plans", "active.json"), JSON.stringify(plan, null, 2));

    const newModule = new ExecutionModule(tempDir, 8);
    const restored = newModule.restorePlan();
    expect(restored).toBe(true);
    const currentStep = newModule.getTracker()!.getCurrentStep();
    expect(currentStep?.id).toBe(2);
    expect(currentStep?.description).toBe("create file-b.ts");
  });

  it("plugin onBeforeTool blocks after 3 off-step violations", () => {
    execModule.setPlan(mkPlan("Test", ["create src/hello.ts"]));
    const plugin = execModule.getPlugin();
    const ctx = mockCtx();
    const offStepCall = mockToolCall({ arguments: { path: "src/other.ts" } });

    // 1st warning — not blocked
    expect(plugin.onBeforeTool!(ctx, offStepCall)).toBe(true);
    // 2nd warning — not blocked yet
    expect(plugin.onBeforeTool!(ctx, offStepCall)).toBe(true);
    // 3rd warning → BLOCKED with an explicit reason string
    const blocked = plugin.onBeforeTool!(ctx, offStepCall);
    expect(typeof blocked).toBe("string");
    expect(String(blocked)).toContain("consecutive");
  });

  it("resets warning counter on step change via onBeforeThink", () => {
    execModule.setPlan(mkPlan("Test", ["create src/a.ts", "create src/b.ts"]));
    const plugin = execModule.getPlugin();
    const ctx = mockCtx();
    const offStepCall = mockToolCall({ arguments: { path: "other.ts" } });

    // Burn 3 warnings → blocked with reason
    plugin.onBeforeTool!(ctx, offStepCall);
    plugin.onBeforeTool!(ctx, offStepCall);
    const blocked = plugin.onBeforeTool!(ctx, offStepCall);
    expect(typeof blocked).toBe("string");

    // Advance plan to step 2
    execModule.getTracker()!.updateStepStatus(1, "done");
    execModule.getTracker()!.advance();

    // onBeforeThink resets counter
    plugin.onBeforeThink!(ctx);

    // Should be allowed again
    expect(plugin.onBeforeTool!(ctx, offStepCall)).toBe(true);
  });

  it("on-track calls do not trigger warnings", () => {
    execModule.setPlan(mkPlan("Test", ["create src/hello.ts"]));
    const plugin = execModule.getPlugin();
    const ctx = mockCtx();

    // on-track: same file path
    const onTrackCall = mockToolCall({ arguments: { path: "src/hello.ts" } });
    expect(plugin.onBeforeTool!(ctx, onTrackCall)).toBe(true);

    // Still not blocked after many on-track calls
    for (let i = 0; i < 5; i++) {
      expect(plugin.onBeforeTool!(ctx, onTrackCall)).toBe(true);
    }
  });

  it("does not warn when the step mentions only a URL/domain (no real files)", () => {
    // P1: the raw `\b[\w./\\-]+\.[a-z]+` regex treated a hostname like
    // "example.com" as a step file, so a step "fetch weather.com data" got a
    // phantom step path and ANY unrelated write was flagged off-path.
    // extractFileLikeTokens rejects domains/URLs → stepPaths is empty →
    // checkPlanAlignment is inert. Only real-file steps are enforced.
    execModule.setPlan(mkPlan("Test", ["fetch weather.com data for report"]));
    const plugin = execModule.getPlugin();
    const ctx = mockCtx();

    // A write to a real file must not be blocked by a phantom domain token
    const write = mockToolCall({
      name: "write_file",
      arguments: { path: "src/report.md" },
    });
    for (let i = 0; i < 5; i++) {
      expect(plugin.onBeforeTool!(ctx, write)).toBe(true);
    }
  });

  it("does not warn when the step lists extensions only (tsx/.ts)", () => {
    // P1: "Проверить что остались только .tsx/.ts файлы" produced phantom
    // step path "tsx/.ts" under the raw regex. The shared extractor rejects
    // extension-only segments, so the step has no file tokens at all.
    execModule.setPlan(mkPlan("Test", ["keep only .tsx/.ts files in src"]));
    const plugin = execModule.getPlugin();
    const ctx = mockCtx();

    const write = mockToolCall({
      name: "write_file",
      arguments: { path: "src/App.tsx" },
    });
    for (let i = 0; i < 5; i++) {
      expect(plugin.onBeforeTool!(ctx, write)).toBe(true);
    }
  });
});

describe("Scenario: Step Gate verification", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `mma-gate-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup — best effort */
    }
  });

  it("does NOT advance when files are empty (< 10 chars)", () => {
    const execModule = new ExecutionModule(tempDir, 8);
    execModule.setPlan(mkPlan("Test", ["create src/greet.ts", "create src/util.ts"]));

    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "greet.ts"), "// hi");

    const plugin = execModule.getPlugin();
    const ctx = mockCtx();

    plugin.onAfterTool!(ctx, mockToolCall({ name: "write_file" }), mockResult());

    // Should NOT have advanced — file too short
    expect(execModule.getTracker()!.getCurrentStep()?.id).toBe(1);
  });

  it("advances when all step files exist with real content", () => {
    const execModule = new ExecutionModule(tempDir, 8);
    execModule.setPlan(mkPlan("Test", ["create src/main.ts", "create lib/helper.ts"]));

    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      'import { greet } from "./greet";\nconsole.log(greet("world"));',
    );

    const messages: string[] = [];
    const ctx: any = {
      contextManager: { addMessage: (m: any) => messages.push(m.content) },
    };
    const plugin = execModule.getPlugin();

    plugin.onAfterTool!(ctx, mockToolCall({ name: "write_file" }), mockResult());

    expect(execModule.getTracker()!.getCurrentStep()?.id).toBe(2);
    const okMsg = messages.find((m) => m.includes("MOVING") || m.includes("ПЕРЕХОДИМ"));
    expect(okMsg).toBeTruthy();
    expect(okMsg).toContain("lib/helper.ts");
  });

  it("blocks advancement for dependency steps without lock file", () => {
    const execModule = new ExecutionModule(tempDir, 8);
    execModule.setPlan(
      mkPlan("Test", ["Install dependencies and create package.json", "create src/app.ts"]),
    );

    // Create package.json but NO lock file
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {} }, null, 2),
    );

    const messages: string[] = [];
    const ctx: any = {
      contextManager: { addMessage: (m: any) => messages.push(m.content) },
    };
    const plugin = execModule.getPlugin();

    plugin.onAfterTool!(ctx, mockToolCall({ name: "write_file" }), mockResult());

    // package.json exists but no lock file — deps gate blocks advancement
    expect(execModule.getTracker()!.getCurrentStep()?.id).toBe(1);

    const depsMsg = messages.find(
      (m) =>
        m.includes("dependencies are not installed") || m.includes("зависимости не установлены"),
    );
    expect(depsMsg).toBeTruthy();
  });

  it("escalates to a MUST-update hint on the second deps-gate warning", () => {
    const execModule = new ExecutionModule(tempDir, 8);
    execModule.setPlan(
      mkPlan("Test", ["Install dependencies and create package.json", "create src/app.ts"]),
    );
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }, null, 2));

    const messages: string[] = [];
    const ctx: any = {
      contextManager: { addMessage: (m: any) => messages.push(m.content) },
    };
    const plugin = execModule.getPlugin();

    // First tool result → soft hint (step_gate_deps)
    plugin.onAfterTool!(ctx, mockToolCall({ name: "write_file" }), mockResult());
    expect(messages.some((m) => m.includes("dependencies are not installed"))).toBe(true);

    // Second tool result on the same step → forced instruction
    plugin.onAfterTool!(ctx, mockToolCall({ name: "write_file" }), mockResult());
    expect(
      messages.some((m) => m.includes("2nd warning") || m.includes("второе предупреждение")),
    ).toBe(true);
    // Step still not advanced automatically
    expect(execModule.getTracker()!.getCurrentStep()?.id).toBe(1);
  });

  it("advances dependency step when lock file exists", () => {
    const execModule = new ExecutionModule(tempDir, 8);
    execModule.setPlan(
      mkPlan("Test", ["Run npm install, create package.json", "create src/index.ts"]),
    );

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }, null, 2));
    writeFileSync(join(tempDir, "package-lock.json"), "{}");
    mkdirSync(join(tempDir, "node_modules"), { recursive: true });

    const ctx = mockCtx();
    const plugin = execModule.getPlugin();

    plugin.onAfterTool!(ctx, mockToolCall({ name: "write_file" }), mockResult());

    // Should have advanced — lock file exists + package.json has content
    expect(execModule.getTracker()!.getCurrentStep()?.id).toBe(2);
  });

  it("advances past last step with final message", () => {
    const execModule = new ExecutionModule(tempDir, 8);
    execModule.setPlan(mkPlan("Test", ["create final/config.ts", "create final/validate.ts"]));

    mkdirSync(join(tempDir, "final"), { recursive: true });
    writeFileSync(join(tempDir, "final", "config.ts"), "export const config = { debug: true };\n");

    const messages: string[] = [];
    const ctx: any = {
      contextManager: { addMessage: (m: any) => messages.push(m.content) },
    };
    const plugin = execModule.getPlugin();

    plugin.onAfterTool!(ctx, mockToolCall({ name: "write_file" }), mockResult());

    // Step 1 done, current step is now 2 (in_progress).
    expect(execModule.getTracker()!.getStep(1)?.status).toBe("done");
    expect(execModule.getTracker()!.getCurrentStep()?.id).toBe(2);

    // The "step gate ok" message was emitted (moving to next step).
    const nextStepMsg = messages.find((m) => m.includes("Step 1 completed") || m.includes("Шаг 1"));
    expect(nextStepMsg).toBeTruthy();
  });
});

describe("Scenario: rewrite of completed-step files is not blocked", () => {
  it("allows writing files that belong to done steps (fixing type errors)", () => {
    const execModule = new ExecutionModule(mkdtempSync(join(tmpdir(), "mma-exec-scen-")), 8);
    execModule.setPlan(mkPlan("Test", ["create src/a.ts", "create src/b.ts"]));
    const tracker = execModule.getTracker()!;
    tracker.updateStepStatus(1, "done");
    tracker.advance();
    expect(tracker.getCurrentStep()?.id).toBe(2);

    const plugin = execModule.getPlugin();
    const ctx = mockCtx();

    // Rewriting a file from the DONE step 1 must NOT warn/block
    const rewriteDone = mockToolCall({
      name: "write_file",
      arguments: { path: "src/a.ts" },
    });
    expect(plugin.onBeforeTool!(ctx, rewriteDone)).toBe(true);

    // Writing a file unrelated to the plan still warns on call 1-2,
    // then blocks on the 3rd consecutive off-plan call
    const offPlan = mockToolCall({
      name: "write_file",
      arguments: { path: "scratch.ts" },
    });
    expect(plugin.onBeforeTool!(ctx, offPlan)).toBe(true);
    expect(plugin.onBeforeTool!(ctx, offPlan)).toBe(true);
    expect(typeof plugin.onBeforeTool!(ctx, offPlan)).toBe("string");
  });
});
