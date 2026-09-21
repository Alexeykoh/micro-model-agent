import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULTS } from "../../../src/config/defaults";
import type { MoEPlan } from "../../../src/modules/execution/types";
import { MoEExecutor } from "../../../src/modules/execution/moe-executor";
import { buildInputSection } from "../../../src/modules/execution/input-from";
import { validatePlan, applyAutoFixes } from "../../../src/modules/execution/plan-validator";
import { ToolRegistry } from "../../../src/tools/registry";
import type { ToolDefinition } from "../../../src/tools/types";
import type { AppConfig } from "../../../src/config/types";

function makeConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
}

function sub(id: string, extra: Partial<MoEPlan["subtasks"][number]> = {}): MoEPlan["subtasks"][number] {
  return {
    id,
    description: `do ${id}`,
    expert_tag: "code",
    allowed_files: [],
    read_only_files: [],
    depends_on: [],
    input_from: [],
    expected_output: "",
    success_criteria: [],
    ...extra,
  };
}

describe("MoE input_from data flow", () => {
  let registry: ToolRegistry;
  let subagentHandler: any;
  let capturedArgs: any[];

  beforeEach(() => {
    capturedArgs = [];
    registry = new ToolRegistry();
    subagentHandler = vi.fn().mockImplementation(async (_ctx: any, args: any) => {
      capturedArgs.push(args);
      return { success: true, output: "ok" };
    });
    const mockSubagentTool: ToolDefinition = {
      name: "subagent",
      description: "Mock subagent",
      parameters: { type: "object", properties: {} },
      tags: ["code"],
      handler: subagentHandler,
    };
    registry.register(mockSubagentTool);
  });

  function createExecutor(config: AppConfig = makeConfig()) {
    return new MoEExecutor({
      config,
      toolRegistry: registry,
      toolExecutor: {} as any,
      llmProvider: {} as any,
      logger: { debug: () => {}, warn: () => {}, info: () => {} } as any,
      baseDir: "/tmp/moe-input-test",
    });
  }

  it("injects the dependency's result into the dependent subtask prompt", async () => {
    const plan: MoEPlan = {
      title: "flow",
      subtasks: [
        sub("a", { allowed_files: ["data.txt"], expected_output: "data" }),
        sub("b", { depends_on: ["a"], input_from: ["a"] }),
      ],
      shared_context: { rules: [], refs: [] },
    };

    // We can't script per-subtask results through the shared handler easily,
    // so run the executor twice: first wave produces a's result, second wave
    // needs it in b's prompt.
    const handlerResults = ["alpha output"];
    subagentHandler.mockImplementation(async (_ctx: any, args: any) => {
      capturedArgs.push(args);
      return { success: true, output: handlerResults[capturedArgs.length - 1] ?? "ok" };
    });

    await createExecutor().executePlan(plan);

    expect(capturedArgs).toHaveLength(2);
    const bPrompt = String(capturedArgs[1].task);
    expect(bPrompt).toContain("Input from previous tasks");
    expect(bPrompt).toContain("alpha output");
  });

  it("marks a failed dependency explicitly in the prompt", async () => {
    const plan: MoEPlan = {
      title: "flow-fail",
      subtasks: [
        sub("a"),
        sub("b", { depends_on: ["a"], input_from: [{ subtaskId: "a" }] }),
      ],
      shared_context: { rules: [], refs: [] },
    };

    subagentHandler.mockImplementation(async (_ctx: any, args: any) => {
      capturedArgs.push(args);
      if (capturedArgs.length === 1) {
        return { success: false, output: "disk exploded" };
      }
      return { success: true, output: "ok" };
    });

    await createExecutor().executePlan(plan);

    const bPrompt = String(capturedArgs[1].task);
    expect(bPrompt).toContain("[FAILED]");
    expect(bPrompt).toContain("disk exploded");
  });

  it("truncates oversized dependency output to maxSummaryChars", async () => {
    const config = makeConfig();
    config.subagent!.maxSummaryChars = 50;
    const plan: MoEPlan = {
      title: "flow-trunc",
      subtasks: [
        sub("a"),
        sub("b", { depends_on: ["a"], input_from: ["a"] }),
      ],
      shared_context: { rules: [], refs: [] },
    };

    const longOutput = "x".repeat(5000);
    subagentHandler.mockImplementation(async (_ctx: any, args: any) => {
      capturedArgs.push(args);
      if (capturedArgs.length === 1) return { success: true, output: longOutput };
      return { success: true, output: "ok" };
    });

    await createExecutor(config).executePlan(plan);

    const bPrompt = String(capturedArgs[1].task);
    const injected = bPrompt.split("Input from previous tasks:\n")[1]?.split("\n")[0] ?? "";
    expect(injected.length).toBeLessThanOrEqual(200); // "- a: " + truncation marker + 50 chars
    expect(injected).toContain("…");
  });
});

describe("buildInputSection aggregate cap", () => {
  it("omits inputs once the total budget is reached", () => {
    const subtask = sub("b", { input_from: ["a", "c", "d", "e", "f"] });
    const depResults = new Map(
      ["a", "c", "d", "e", "f"].map((id) => [
        id,
        { subtaskId: id, success: true, summary: "", result: "y".repeat(50), error: "" } as any,
      ]),
    );
    // maxChars=30 → агрегатный кап 120; влезает лишь часть строк.
    const section = buildInputSection(subtask, depResults, 30);
    expect(section).toContain("omitted");
    const contentLines = section
      .split("\n")
      .filter((l) => l.startsWith("- ") && !l.includes("omitted"));
    expect(contentLines.length).toBe(3);
  });
});

describe("validatePlan input_from references", () => {
  function planOf(subtasks: MoEPlan["subtasks"]): MoEPlan {
    return { title: "t", subtasks, shared_context: { rules: [], refs: [] } };
  }
  const cfg = makeConfig();

  it("errors on unknown input_from reference", () => {
    const v = validatePlan(planOf([sub("b", { input_from: ["ghost"] })]), cfg);
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("ghost");
  });

  it("auto-fixes missing depends_on for a valid reference", () => {
    const plan = planOf([sub("a"), sub("b", { input_from: ["a"] })]);
    const v = validatePlan(plan, cfg);
    expect(v.errors).toHaveLength(0);
    expect(v.autoFixes.length).toBeGreaterThan(0);

    const fixed = applyAutoFixes(plan, v.autoFixes);
    expect(fixed.subtasks[1].depends_on).toContain("a");
    expect(validatePlan(fixed, cfg).valid).toBe(true);
  });

  it("passes clean when reference has its depends_on", () => {
    const v = validatePlan(planOf([sub("a"), sub("b", { depends_on: ["a"], input_from: ["a"] })]), cfg);
    expect(v.valid).toBe(true);
    expect(v.autoFixes).toHaveLength(0);
  });
});
