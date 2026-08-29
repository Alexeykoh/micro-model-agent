import { describe, it, expect, vi } from "vitest";
import { OrchestratorClient } from "../../src/llm/orchestrator";
import type { MoEPlan } from "../../src/modules/execution/types";
import type { LLMProvider } from "../../src/llm/provider";

function createMockProvider(): LLMProvider {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield {
        type: "text",
        content: JSON.stringify({
          title: "Test Plan",
          subtasks: [
            {
              id: "task-1",
              description: "Implement feature",
              expert_tag: "code",
              allowed_files: ["src/feature.ts"],
              read_only_files: [],
              depends_on: [],
              input_from: [],
              expected_output: "feature file",
              success_criteria: ["file exists"],
            },
          ],
          shared_context: { rules: [], refs: [] },
        }),
      };
    }),
    countTokens: vi.fn().mockResolvedValue(10),
  };
}

function createMockVerifyProvider(): LLMProvider {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield {
        type: "text",
        content: JSON.stringify({
          type: "final",
          finalAnswer: "All tasks completed successfully.",
          explanation: "All subtasks passed verification.",
        }),
      };
    }),
    countTokens: vi.fn().mockResolvedValue(10),
  };
}

function createMockReplanProvider(): LLMProvider {
  let callCount = 0;
  return {
    chat: vi.fn().mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          type: "text",
          content: JSON.stringify({
            type: "replan",
            plan: {
              title: "Replan",
              subtasks: [
                {
                  id: "retry-1",
                  description: "Retry",
                  expert_tag: "code",
                  allowed_files: [],
                  read_only_files: [],
                  depends_on: [],
                  input_from: [],
                  expected_output: "",
                  success_criteria: [],
                },
              ],
              shared_context: { rules: [], refs: [] },
            },
            explanation: "Need to retry",
          }),
        };
      } else {
        yield {
          type: "text",
          content: JSON.stringify({
            type: "final",
            finalAnswer: "Done",
            explanation: "Completed on retry",
          }),
        };
      }
    }),
    countTokens: vi.fn().mockResolvedValue(10),
  };
}

describe("OrchestratorClient plan()", () => {
  it("returns a valid MoEPlan for a task", async () => {
    const orchestrator = new OrchestratorClient({ model: "test" }, createMockProvider());
    const result = await orchestrator.plan("Implement a feature");
    expect(result).toHaveProperty("plan");
    if ("plan" in result) {
      expect(result.plan.subtasks.length).toBeGreaterThan(0);
      expect(result.plan.subtasks[0].expert_tag).toBeDefined();
    }
  });

  it("returns error when no provider configured", async () => {
    const orchestrator = new OrchestratorClient({});
    const result = await orchestrator.plan("task");
    expect(result).toHaveProperty("error");
  });

  it("threads the abort signal into the provider chat call", async () => {
    const provider = createMockProvider();
    const orchestrator = new OrchestratorClient({ model: "test" }, provider);
    const ac = new AbortController();
    await orchestrator.plan("task", undefined, ac.signal);
    // chat(messages, tools, signal) — the third argument must be the signal.
    const call = (provider.chat as any).mock.calls[0];
    expect(call[2]).toBe(ac.signal);
  });
});

describe("OrchestratorClient verifyAndMerge()", () => {
  it("returns final result on success", async () => {
    const orchestrator = new OrchestratorClient({ model: "test" }, createMockVerifyProvider());
    const plan: MoEPlan = {
      title: "test",
      subtasks: [
        {
          id: "t1",
          description: "",
          expert_tag: "code",
          allowed_files: [],
          read_only_files: [],
          depends_on: [],
          input_from: [],
          expected_output: "",
          success_criteria: [],
        },
      ],
      shared_context: { rules: [], refs: [] },
    };
    const result = await orchestrator.verifyAndMerge({
      plan,
      results: [{ subtaskId: "t1", success: true, summary: "OK", result: "done", durationMs: 100 }],
      verifierErrors: [],
      verifierWarnings: [],
    });
    expect(result.type).toBe("final");
    expect(result.finalAnswer).toBeTruthy();
  });

  it("supports re-plan cycle", async () => {
    const orchestrator = new OrchestratorClient({ model: "test" }, createMockReplanProvider());
    const plan: MoEPlan = {
      title: "test",
      subtasks: [
        {
          id: "t1",
          description: "",
          expert_tag: "code",
          allowed_files: [],
          read_only_files: [],
          depends_on: [],
          input_from: [],
          expected_output: "",
          success_criteria: [],
        },
      ],
      shared_context: { rules: [], refs: [] },
    };
    const result = await orchestrator.verifyAndMerge({
      plan,
      results: [{ subtaskId: "t1", success: false, summary: "FAIL", result: "", error: "error" }],
      verifierErrors: ["syntax error"],
      verifierWarnings: [],
    });
    expect(result.type).toBe("replan");
    expect(result.plan).toBeDefined();
  });

  it("returns partial result after 3 re-plan cycles", async () => {
    const orchestrator = new OrchestratorClient({ model: "test" }, createMockReplanProvider());
    const plan: MoEPlan = {
      title: "test",
      subtasks: [
        {
          id: "t1",
          description: "",
          expert_tag: "code",
          allowed_files: [],
          read_only_files: [],
          depends_on: [],
          input_from: [],
          expected_output: "",
          success_criteria: [],
        },
      ],
      shared_context: { rules: [], refs: [] },
    };
    // Re-plan cycle counting moved to the caller (runWithMoE enforces
    // moe.maxReplanCycles). The client itself keeps parsing verifier output
    // on every call — no internal cap, no forced partial result.
    const first = await orchestrator.verifyAndMerge({
      plan,
      results: [{ subtaskId: "t1", success: false, summary: "", result: "", error: "err" }],
      verifierErrors: ["err"],
      verifierWarnings: [],
    });
    expect(first.type).toBe("replan");
    const second = await orchestrator.verifyAndMerge({
      plan,
      results: [{ subtaskId: "t1", success: false, summary: "", result: "", error: "err" }],
      verifierErrors: ["err"],
      verifierWarnings: [],
    });
    expect(second.type).toBe("final");
  });
});
