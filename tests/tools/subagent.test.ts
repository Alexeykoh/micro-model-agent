import { describe, it, expect, vi } from "vitest";
import { subagentTool } from "../../src/tools/subagent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockAgentRun = vi
  .fn()
  .mockResolvedValue({ success: true, text: "done", iterationCount: 1 });
const mockAgent = vi.fn().mockReturnValue({ run: mockAgentRun });

vi.mock("../../src/core/agent", () => ({
  Agent: mockAgent,
}));

describe("subagentTool", () => {
  it("has correct definition", () => {
    expect(subagentTool.name).toBe("subagent");
    expect(subagentTool.description).toBeTruthy();
    expect(subagentTool.parameters.required).toContain("task");
    const props = subagentTool.parameters.properties as Record<string, any>;
    expect(props.task).toBeDefined();
    expect(props.context).toBeDefined();
  });

  it("fails when task is empty", async () => {
    const result = await subagentTool.handler(
      {
        config: {
          contextWindow: 32768,
          contextBudget: {
            systemPrompt: 0.25,
            responseReserve: 0.12,
            compactionThreshold: 0.75,
          },
        },
        baseDir: "/tmp",
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      } as any,
      {
        task: "",
      },
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("task");
  });

  it("has context parameter for additional constraints", () => {
    const props = subagentTool.parameters.properties as Record<string, any>;
    expect(props.context.type).toBe("string");
    expect(props.context.description).toContain("context");
  });

  it("has scope and tool_tags parameters", () => {
    const props = subagentTool.parameters.properties as Record<string, any>;
    expect(props.allowed_files).toBeDefined();
    expect(props.read_only_files).toBeDefined();
    expect(props.tool_tags).toBeDefined();
    expect(props.expert_tag).toBeDefined();
  });

  it("fails when llmProvider or toolExecutor is missing", async () => {
    const result = await subagentTool.handler(
      {
        config: {
          contextWindow: 32768,
          contextBudget: {
            systemPrompt: 0.25,
            responseReserve: 0.12,
            compactionThreshold: 0.75,
          },
        },
        baseDir: "/tmp",
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      } as any,
      {
        task: "do something",
      },
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("missing llmProvider or toolExecutor");
  });

  it("passes scope and toolTags to Agent deps", async () => {
    mockAgent.mockClear();
    mockAgentRun.mockResolvedValue({
      success: true,
      text: "done",
      iterationCount: 1,
    });

    const result = await subagentTool.handler(
      {
        config: {
          contextWindow: 32768,
          contextBudget: {
            systemPrompt: 0.25,
            responseReserve: 0.12,
            compactionThreshold: 0.75,
          },
        },
        baseDir: "/tmp",
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        llmProvider: {} as any,
        toolExecutor: {
          execute: () => ({}),
          getToolDefinitions: (tags?: string[]) =>
            (tags || []).length > 0
              ? tags!.map((tag) => ({
                  name: "write_file",
                  description: "d",
                  parameters: {},
                  tags: [tag],
                }))
              : [],
          getRegistry: () => ({
            getAll: () => [],
            get: () => undefined,
            register: () => {},
            has: () => false,
            list: () => [],
          }),
          setScope: () => {},
        } as any,
      } as any,
      {
        task: "do something",
        allowed_files: ["src/file.ts"],
        read_only_files: ["docs/readme.md"],
        tool_tags: ["file", "code"],
      },
    );

    expect(result.success).toBe(true);
    const deps = mockAgent.mock.calls[0][0];
    expect(deps.scope).toEqual({
      allowed_files: ["src/file.ts"],
      read_only_files: ["docs/readme.md"],
    });
    expect(deps.toolTags).toEqual(["file", "code"]);
  });

  it("saves result to an artifact and returns a bounded summary when result_mode is file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-subagent-"));
    try {
      mockAgentRun.mockResolvedValue({
        success: true,
        text: "big result ".repeat(500) + "TAIL_MARKER_XYZ",
        iterationCount: 3,
      });
      const result = await subagentTool.handler(
        {
          config: {
            contextWindow: 32768,
            contextBudget: {
              systemPrompt: 0.25,
              responseReserve: 0.12,
              compactionThreshold: 0.75,
            },
            subagent: {
              resultMode: "text",
              maxSummaryChars: 2000,
              artifactsDir: ".mma/artifacts",
              stableSystemPrompt: true,
              maxParallelChunkQueries: 4,
            },
          },
          baseDir: dir,
          sessionId: "ses_x",
          logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          llmProvider: {} as any,
          toolExecutor: {
            execute: () => ({}),
            getToolDefinitions: () => [],
            getRegistry: () => ({ getAll: () => [], get: () => undefined, register: () => {}, has: () => false, list: () => [] }),
            setScope: () => {},
          },
        } as any,
        { task: "do something", result_mode: "file" },
      );

      expect(result.success).toBe(true);
      // full 5500-char result must NOT be in context output
      expect(result.output).not.toContain("TAIL_MARKER_XYZ");
      expect(result.output).toContain("[truncated");
      expect(result.output).toContain("artifact");
      expect(result.output).toContain(join(".mma", "artifacts", "ses_x"));
      expect(result.output.length).toBeLessThan(2500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds result_mode and artifact_name parameters", () => {
    const props = subagentTool.parameters.properties as Record<string, any>;
    expect(props.result_mode).toBeDefined();
    expect(props.result_mode.enum).toEqual(["text", "file"]);
    expect(props.artifact_name).toBeDefined();
  });

  it("keeps the system prompt fixed (KV-cache friendly) and puts context into the user message", async () => {
    mockAgent.mockClear();
    mockAgentRun.mockClear();
    mockAgentRun.mockResolvedValue({ success: true, text: "done", iterationCount: 1 });
    await subagentTool.handler(
      {
        config: {
          contextWindow: 32768,
          contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
          subagent: { resultMode: "text", maxSummaryChars: 2000, artifactsDir: ".mma/artifacts", stableSystemPrompt: true, maxParallelChunkQueries: 4 },
        },
        baseDir: "/tmp",
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        llmProvider: {} as any,
        toolExecutor: {
          execute: () => ({}),
          getToolDefinitions: (tags?: string[]) => (tags || []).map((tag: string) => ({ name: "write_file", description: "d", parameters: {}, tags: [tag] })),
          getRegistry: () => ({ getAll: () => [], get: () => undefined, register: () => {}, has: () => false, list: () => [] }),
          setScope: () => {},
        },
      } as any,
      { task: "do task", context: "VARIABLE_CONTEXT_XYZ", tool_tags: ["file"] },
    );

    const deps = mockAgent.mock.calls[0][0];
    expect(deps.promptBlocks[0].content).not.toContain("VARIABLE_CONTEXT_XYZ");
    expect(mockAgentRun.mock.calls[0][0]).toContain("VARIABLE_CONTEXT_XYZ");
  });

  it("includes the RLM few-shot workflow guidance in the system prompt", async () => {
    mockAgent.mockClear();
    mockAgentRun.mockClear();
    mockAgentRun.mockResolvedValue({ success: true, text: "done", iterationCount: 1 });
    await subagentTool.handler(
      {
        config: {
          contextWindow: 32768,
          contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
          subagent: { resultMode: "text", maxSummaryChars: 2000, artifactsDir: ".mma/artifacts", stableSystemPrompt: true, maxParallelChunkQueries: 4 },
        },
        baseDir: "/tmp",
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        llmProvider: {} as any,
        toolExecutor: {
          execute: () => ({}),
          getToolDefinitions: (tags?: string[]) => (tags || []).map((tag: string) => ({ name: "write_file", description: "d", parameters: {}, tags: [tag] })),
          getRegistry: () => ({ getAll: () => [], get: () => undefined, register: () => {}, has: () => false, list: () => [] }),
          setScope: () => {},
        },
      } as any,
      { task: "t", tool_tags: ["file"] },
    );

    const deps = mockAgent.mock.calls[0][0];
    expect(deps.promptBlocks[0].content).toContain("write_file");
    expect(deps.promptBlocks[0].content).toContain("subagent");
    expect(deps.promptBlocks[0].content).toMatch(/verify/i);
  });
});
