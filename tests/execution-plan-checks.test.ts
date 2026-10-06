import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExecutionModule } from "../src/modules/execution/module";
import { createTestModule, cleanupTestModule, writeTestFile } from "./plan-test-utils";
import { parseCheck, isValidCheck } from "../src/modules/execution/plan-checks";

function planTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
}

function todoTool(execModule: ExecutionModule) {
  return execModule.getToolDefinitions().find((t) => t.name === "todo")!;
}

function taskCtx(task: string): any {
  return {
    contextManager: {
      getActiveHistory: () => [{ role: "user", content: task }],
    },
  };
}

describe("parseCheck", () => {
  it("parses the three prefixes", () => {
    expect(parseCheck("file-exists:src/a.ts")).toEqual({ kind: "file", target: "src/a.ts" });
    expect(parseCheck("command:bun test")).toEqual({ kind: "command", target: "bun test" });
    expect(parseCheck("manual:look at the page")).toEqual({ kind: "manual", target: "look at the page" });
  });

  it("rejects missing prefix, empty target, and non-strings", () => {
    expect(parseCheck("src/a.ts")).toBeNull();
    expect(parseCheck("file-exists:   ")).toBeNull();
    expect(parseCheck("explode:src/a.ts")).toBeNull();
    expect(isValidCheck("command: bun test")).toBe(true);
    expect(isValidCheck("no prefix here")).toBe(false);
    expect(isValidCheck(42)).toBe(false);
  });
});

describe("plan create checks gate", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-checks-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  it("self-certifies create without checks", async () => {
    const res = await planTool(execModule).handler(
      {},
      { action: "create", title: "T", steps: ["Create src/a.ts"] },
    );
    expect(res.success).toBe(true);
    expect(execModule.getTracker()!.getStep(1)!.check?.startsWith("manual:")).toBe(true);
  });

  it("self-repairs a checks length mismatch instead of blocking create", async () => {
    const res = await planTool(execModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Create src/a.ts", "Create src/b.ts"],
        checks: ["file-exists:src/a.ts"],
      },
    );
    expect(res.success).toBe(true);
    const tracker = execModule.getTracker()!;
    expect(tracker.getStep(1)!.check).toBe("file-exists:src/a.ts");
    expect(tracker.getStep(2)!.check?.startsWith("manual:")).toBe(true);
  });

  it("drops extra checks beyond the step count", async () => {
    const res = await planTool(execModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Create src/a.ts"],
        checks: ["file-exists:src/a.ts", "file-exists:src/extra.ts"],
      },
    );
    expect(res.success).toBe(true);
    expect(execModule.getTracker()!.getStep(1)!.check).toBe("file-exists:src/a.ts");
  });

  it("blocks create on an invalid check prefix", async () => {
    const res = await planTool(execModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Create src/a.ts"],
        checks: ["look at src/a.ts"],
      },
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain("file-exists");
  });

  it("stores checks on steps and renders them in the prompt block", async () => {
    const res = await planTool(execModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Create src/a.ts with X"],
        checks: ["file-exists:src/a.ts"],
      },
    );
    expect(res.success).toBe(true);
    const step = execModule.getTracker()!.getStep(1)!;
    expect(step.check).toBe("file-exists:src/a.ts");
    expect(execModule.getTracker()!.toPromptBlock()).toContain("check: file-exists:src/a.ts");
  });

  it("blocks create when task files are not covered (coverage block)", async () => {
    const res = await planTool(execModule).handler(
      taskCtx("Create src/app.ts and src/store.ts with a todo list"),
      {
        action: "create",
        title: "T",
        steps: ["Create src/app.ts with UI"],
        checks: ["file-exists:src/app.ts"],
      },
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain("src/store.ts");
    expect(execModule.getTracker()).toBeNull();
  });

  it("passes coverage when all task files are named", async () => {
    const res = await planTool(execModule).handler(
      taskCtx("Create src/app.ts and src/store.ts"),
      {
        action: "create",
        title: "T",
        steps: ["Create src/app.ts with UI", "Create src/store.ts with state"],
        checks: ["file-exists:src/app.ts", "file-exists:src/store.ts"],
      },
    );
    expect(res.success).toBe(true);
  });

  it("re-plan self-certifies new steps when checks are omitted", async () => {
    const tool = planTool(execModule);
    await tool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Create src/a.ts", "Create src/b.ts"],
        checks: ["file-exists:src/a.ts", "file-exists:src/b.ts"],
      },
    );
    const ok = await tool.handler({}, { action: "re-plan", steps: ["Create src/c.ts"] });
    expect(ok.success).toBe(true);
    const replanned = execModule.getTracker()!.getPlan();
    const newStep = replanned.steps.find((s) => s.description.includes("src/c.ts"));
    expect(newStep?.check?.startsWith("manual:")).toBe(true);
  });

  it("hard-verifies file-exists checks on done", async () => {
    const tool = planTool(execModule);
    await tool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Create src/a.ts with X"],
        checks: ["file-exists:src/a.ts"],
      },
    );
    const blocked = await tool.handler({}, { action: "update", step: 1, status: "done" });
    expect(blocked.success).toBe(false);
    expect(blocked.output).toContain("file-exists:src/a.ts");

    writeTestFile(tmpDir, "src/a.ts", "export const a = 1;\n");
    const ok = await tool.handler({}, { action: "update", step: 1, status: "done" });
    expect(ok.success).toBe(true);
  });

  it("self-certified command checks pass with a note", async () => {
    const tool = planTool(execModule);
    await tool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Run the test suite"],
        checks: ["command:bun test"],
      },
    );
    const res = await tool.handler({}, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("command:bun test");
  });

  it("reverse auto-switches delete-kind to create when files were never deleted", async () => {
    // Detector present but nothing tracked as deleted: files that neither
    // exist nor were deleted name work that was never done → create intent.
    execModule.setHallucinationDetector({
      getConsistencyCheck: () => ({ getDeletedFiles: () => [] }) as any,
    } as any);
    const tool = planTool(execModule);
    await tool.handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Remove src/ghost.ts"],
        checks: ["file-exists:src/ghost.ts"],
        kinds: ["delete"],
      },
    );
    expect(execModule.getTracker()!.getStep(1)!.kind).toBe("delete");
    // Never created, never deleted via tools → intent must be create.
    const res = await tool.handler({}, { action: "update", step: 1, status: "done" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("src/ghost.ts");
    expect(execModule.getTracker()!.getStep(1)!.kind).toBe("create");
  });
});

describe("plan_step tool", () => {
  let stepDir: string;
  let stepModule: ExecutionModule;

  beforeEach(() => {
    stepDir = createTestModule("mma-planstep-").tmpDir;
    stepModule = new ExecutionModule(stepDir, 8);
  });

  afterEach(() => {
    cleanupTestModule(stepDir);
  });

  function stepTool() {
    return stepModule.getToolDefinitions().find((t) => t.name === "plan_step")!;
  }

  it("is registered as alwaysOn with step/status schema", () => {
    const tool = stepTool();
    expect(tool).toBeDefined();
    const props = tool!.parameters.properties as Record<string, any>;
    expect(props.step).toBeDefined();
    expect(props.status.enum).toEqual(["done", "failed", "skipped"]);
    expect(tool!.parameters.required).toContain("step");
  });

  it("marks a step done exactly like plan update", async () => {
    await planTool(stepModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Do things"],
        checks: ["manual:verify things"],
      },
    );
    const res = await stepTool().handler({}, { step: 1, status: "done" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("done");
  });

  it("requires the step number and an active plan", async () => {
    const noPlan = await stepTool().handler({}, { step: 1, status: "done" });
    expect(noPlan.success).toBe(false);

    await planTool(stepModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Do things"],
        checks: ["manual:verify things"],
      },
    );
    const noStep = await stepTool().handler({}, { status: "done" });
    expect(noStep.success).toBe(false);
  });

  it("enforces the same gates (order + checks) as plan update", async () => {
    await planTool(stepModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["First", "Second"],
        checks: ["manual:verify first", "manual:verify second"],
      },
    );
    const jump = await stepTool().handler({}, { step: 2, status: "done" });
    expect(jump.success).toBe(false);
    expect(jump.output).toContain("step 1");
  });
});

describe("todo ids", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-todoids-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  async function setup() {
    await planTool(execModule).handler(
      {},
      {
        action: "create",
        title: "T",
        steps: ["Do things"],
        checks: ["manual:verify things"],
      },
    );
    await todoTool(execModule).handler({}, { action: "add", items: ["Alpha", "Beta"] });
  }

  it("marks done by ids and reports unknown ids", async () => {
    await setup();
    const ok = await todoTool(execModule).handler({}, { action: "done", ids: [1] });
    expect(ok.success).toBe(true);
    const step = execModule.getTracker()!.getCurrentStep()!;
    expect(step.subtasks!.find((s) => s.id === 1)!.done).toBe(true);
    expect(step.subtasks!.find((s) => s.id === 2)!.done).toBe(false);

    const bad = await todoTool(execModule).handler({}, { action: "done", ids: [99] });
    expect(bad.success).toBe(false);
    expect(bad.output).toContain("99");
  });

  it("lists subtasks with ids and add reports ids", async () => {
    await setup();
    const list = await todoTool(execModule).handler({}, { action: "list" });
    expect(list.success).toBe(true);
    expect(list.output).toContain("[1]");
    expect(list.output).toContain("[2]");
  });

  it("keeps text matching as a fallback", async () => {
    await setup();
    const res = await todoTool(execModule).handler({}, { action: "done", items: ["alpha"] });
    expect(res.success).toBe(true);
  });
});
