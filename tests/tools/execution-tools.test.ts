import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExecutionModule } from "../../src/modules/execution/module";

describe("ExecutionModule tools", () => {
  let execModule: ExecutionModule;
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "mma-exectools-"));
    execModule = new ExecutionModule(tmpBase, 8);
  });

  afterEach(() => {
    if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
  });

  describe("plan tool", () => {
    it("has correct definition", () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan");
      expect(planTool).toBeDefined();
      expect(planTool!.description).toBeTruthy();
      expect(planTool!.parameters.required).toContain("action");
      const props = planTool!.parameters.properties as Record<string, any>;
      expect(props.action.enum).toContain("create");
      expect(props.action.enum).toContain("update");
      expect(props.action.enum).toContain("abort");
    });

    it("creates plan with action=create", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const ctx = { logger: { warn: () => {} } } as any;

      const result = await planTool.handler(ctx, {
        action: "create",
        title: "Test Plan",
        steps: [
          "This is step one with detail",
          "This is step two with detail",
          "This is step three with detail",
        ],
        checks: ["manual:verify This is step one with detail", "manual:verify This is step two with detail", "manual:verify This is step three with detail"],
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Test Plan");
      expect(result.output).toContain("3");
      expect(execModule.getTracker()).not.toBeNull();
    });

    it("updates step status with action=update", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "Test",
        steps: ["First step with enough chars here", "Second step with enough chars"],
        checks: ["manual:verify First step with enough chars here", "manual:verify Second step with enough chars"],
      });

      const result = await planTool.handler(ctx, {
        action: "update",
        step: 1,
        status: "done",
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("1");
      expect(result.output).toContain("done");
    });

    it("aborts plan with action=abort", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "Test",
        steps: ["This is a step with enough chars to pass"],
        checks: ["manual:verify This is a step with enough chars to pass"],
      });

      expect(execModule.getTracker()).not.toBeNull();

      const result = await planTool.handler(ctx, {
        action: "abort",
      });

      expect(result.success).toBe(true);
      expect(execModule.getTracker()).toBeNull();
    });

    it("fails to update without active plan", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const ctx = { logger: { warn: () => {} } } as any;

      const result = await planTool.handler(ctx, {
        action: "update",
        step: 1,
        status: "done",
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("No active plan");
    });

    it("refuses to mark a later step done before earlier steps", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "T",
        steps: [
          "First step with enough chars here",
          "Second step with enough chars here",
          "Third step with enough chars here",
        ],
        checks: ["manual:verify First step with enough chars here", "manual:verify Second step with enough chars here", "manual:verify Third step with enough chars here"],
      });

      const result = await planTool.handler(ctx, {
        action: "update",
        step: 3,
        status: "done",
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("step 1");
    });

    it("marks an already-done step done again idempotently (success, not an error)", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "T",
        steps: ["First step with enough chars here", "Second step with enough chars here"],
        checks: ["manual:verify First step with enough chars here", "manual:verify Second step with enough chars here"],
      });
      await planTool.handler(ctx, { action: "update", step: 1, status: "done" });
      const second = await planTool.handler(ctx, {
        action: "update",
        step: 1,
        status: "done",
      });
      expect(second.success).toBe(true);
      expect(second.output).toContain("already");
      expect(second.output).toContain("1/2");
    });

    it("shows an archived plan by id (does not ignore the id argument)", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "Old Plan",
        steps: ["First step with enough chars here"],
        checks: ["manual:verify First step with enough chars here"],
      });
      const oldPlan = execModule.getTracker()!.getPlan();
      const oldId = oldPlan.id;
      await planTool.handler(ctx, { action: "abort" });

      await planTool.handler(ctx, {
        action: "create",
        title: "New Plan",
        steps: ["Another step with enough chars here"],
        checks: ["manual:verify Another step with enough chars here"],
      });

      const result = await planTool.handler(ctx, {
        action: "show",
        id: oldId,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain(oldId);
      expect(result.output).toContain("Old Plan");
      expect(result.output).not.toContain("New Plan");
    });

    it("reports plan not found when showing a nonexistent id", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const ctx = { logger: { warn: () => {} } } as any;

      const result = await planTool.handler(ctx, {
        action: "show",
        id: "plan_nope",
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("not found");
    });
  });

  describe("todo tool", () => {
    it("has correct definition", () => {
      const tools = execModule.getToolDefinitions();
      const todoTool = tools.find((t) => t.name === "todo")!;
      expect(todoTool).toBeDefined();
      expect(todoTool.description).toBeTruthy();
      expect(todoTool.parameters.required).toContain("action");
      const props = todoTool.parameters.properties as Record<string, any>;
      expect(props.action.enum).toContain("add");
      expect(props.action.enum).toContain("done");
      expect(props.action.enum).toContain("list");
    });

    it("adds items to current step", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const todoTool = tools.find((t) => t.name === "todo")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "Test",
        steps: ["This step has enough chars now"],
        checks: ["manual:verify This step has enough chars now"],
      });

      const result = await todoTool.handler(ctx, {
        action: "add",
        items: ["Sub-task 1", "Sub-task 2"],
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("2");

      const step = execModule.getTracker()!.getCurrentStep()!;
      expect(step.subtasks).toHaveLength(2);
      expect(step.subtasks![0]).toMatchObject({ text: "Sub-task 1", done: false });
      expect(step.status).toBe("pending");
    });

    it("marks individual subtasks done without completing the whole step", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const todoTool = tools.find((t) => t.name === "todo")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "Test",
        steps: ["This step has enough chars now"],
        checks: ["manual:verify This step has enough chars now"],
      });
      await todoTool.handler(ctx, {
        action: "add",
        items: ["Check A", "Check B", "Check C"],
      });

      // Mark only one subtask done — the STEP must NOT become done.
      const result = await todoTool.handler(ctx, {
        action: "done",
        items: ["Check A"],
      });

      expect(result.success).toBe(true);
      const step = execModule.getTracker()!.getCurrentStep()!;
      expect(step.subtasks!.filter((s) => s.done)).toHaveLength(1);
      expect(step.status).toBe("pending");
      expect(execModule.getTracker()!.isComplete()).toBe(false);
    });

    it("reports subtasks not found when done on unknown text", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const todoTool = tools.find((t) => t.name === "todo")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "Test",
        steps: ["This step has enough chars now"],
        checks: ["manual:verify This step has enough chars now"],
      });

      const result = await todoTool.handler(ctx, {
        action: "done",
        items: ["never added"],
      });

      expect(result.success).toBe(false);
      expect(result.output).toMatch(/not found|No matching/i);
    });

    it("lists subtasks with completion status", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const todoTool = tools.find((t) => t.name === "todo")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "Test",
        steps: ["This step has enough chars now"],
        checks: ["manual:verify This step has enough chars now"],
      });
      await todoTool.handler(ctx, {
        action: "add",
        items: ["Task 1"],
      });
      await todoTool.handler(ctx, { action: "done", items: ["Task 1"] });

      const result = await todoTool.handler(ctx, { action: "list" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Task 1");
      expect(result.output).toMatch(/\[x\]|\[✔\]|\[✓\]/);
    });

    it("fails without active plan", async () => {
      const tools = execModule.getToolDefinitions();
      const todoTool = tools.find((t) => t.name === "todo")!;
      const ctx = { logger: { warn: () => {} } } as any;

      const result = await todoTool.handler(ctx, {
        action: "add",
        items: ["Item"],
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("No active plan");
    });
  });
});
