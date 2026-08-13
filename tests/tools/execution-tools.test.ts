import { describe, it, expect, beforeEach } from "vitest";
import { ExecutionModule } from "../../src/modules/execution/module";

describe("ExecutionModule tools", () => {
  let execModule: ExecutionModule;

  beforeEach(() => {
    execModule = new ExecutionModule("/tmp/test", 8);
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
        steps: [
          "First step with enough chars here",
          "Second step with enough chars",
        ],
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
      });

      const result = await planTool.handler(ctx, {
        action: "update",
        step: 3,
        status: "done",
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("step 1");
    });

    it("warns when marking an already-done step done again", async () => {
      const tools = execModule.getToolDefinitions();
      const planTool = tools.find((t) => t.name === "plan")!;
      const ctx = { logger: { warn: () => {} } } as any;

      await planTool.handler(ctx, {
        action: "create",
        title: "T",
        steps: [
          "First step with enough chars here",
          "Second step with enough chars here",
        ],
      });
      await planTool.handler(ctx, { action: "update", step: 1, status: "done" });
      const second = await planTool.handler(ctx, {
        action: "update",
        step: 1,
        status: "done",
      });
      expect(second.success).toBe(false);
      expect(second.output).toContain("already");
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
      });

      const result = await todoTool.handler(ctx, {
        action: "add",
        items: ["Sub-task 1", "Sub-task 2"],
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("2");
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
