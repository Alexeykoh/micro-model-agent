import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolExecutor } from "../src/tools/executor";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolContext } from "../src/tools/types";

describe("ToolExecutor", () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    ctx = {
      config: {} as any,
      baseDir: "/tmp",
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        logToolCall: vi.fn(),
        logToolOutput: vi.fn(),
      } as any,
    };
    executor = new ToolExecutor(registry, ctx, { getAllPlugins: () => [] });
  });

  it("should execute a registered tool", async () => {
    registry.register({
      name: "hello",
      description: "says hello",
      parameters: { type: "object", properties: { name: { type: "string" } } },
      handler: async (_ctx, args) => ({
        success: true,
        output: `Hello ${args.name}`,
      }),
    });

    const result = await executor.execute({
      id: "call_1",
      name: "hello",
      arguments: { name: "world" },
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe("Hello world");
  });

  it("should throw for unknown tool", async () => {
    const result = await executor.execute({
      id: "call_1",
      name: "nonexistent",
      arguments: {},
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool");
  });

  it("should run plugin onBeforeTool hook", async () => {
    registry.register({
      name: "blockable",
      description: "",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "ok" }),
    });

    const onBefore = vi.fn().mockReturnValue(false);
    executor = new ToolExecutor(registry, ctx, {
      getAllPlugins: () => [{ onBeforeTool: onBefore }],
    });

    const result = await executor.execute({
      id: "call_1",
      name: "blockable",
      arguments: {},
    });
    expect(onBefore).toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("should run plugin onAfterTool hook", async () => {
    registry.register({
      name: "tracked",
      description: "",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "done" }),
    });

    const onAfter = vi.fn();
    executor = new ToolExecutor(registry, ctx, {
      getAllPlugins: () => [{ onAfterTool: onAfter }],
    });

    await executor.execute({ id: "call_1", name: "tracked", arguments: {} });
    expect(onAfter).toHaveBeenCalled();
  });

  it("should handle handler errors gracefully", async () => {
    registry.register({
      name: "crash",
      description: "",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        throw new Error("boom");
      },
    });

    const result = await executor.execute({
      id: "call_1",
      name: "crash",
      arguments: {},
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("boom");
  });

  it("should not apply timeout to interactive tools", async () => {
    vi.useFakeTimers();
    try {
      registry.register({
        name: "slow_interactive",
        description: "",
        parameters: { type: "object", properties: {} },
        interactive: true,
        handler: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ success: true, output: "answered" }), 70000),
          ),
      });

      const promise = executor.execute({
        id: "call_1",
        name: "slow_interactive",
        arguments: {},
      });
      vi.advanceTimersByTime(70000);
      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.output).toBe("answered");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should apply timeout to non-interactive tools", async () => {
    vi.useFakeTimers();
    try {
      registry.register({
        name: "slow",
        description: "",
        parameters: { type: "object", properties: {} },
        handler: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ success: true, output: "late" }), 70000),
          ),
      });

      const promise = executor.execute({
        id: "call_1",
        name: "slow",
        arguments: {},
      });
      vi.advanceTimersByTime(61000);
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.output).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should return filtered tool definitions by tags", () => {
    registry.register({
      name: "file_tool",
      description: "",
      parameters: { type: "object", properties: {} },
      tags: ["file"],
      handler: async () => ({ success: true, output: "" }),
    });
    registry.register({
      name: "shell_tool",
      description: "",
      parameters: { type: "object", properties: {} },
      tags: ["shell"],
      handler: async () => ({ success: true, output: "" }),
    });
    registry.register({
      name: "browser_tool",
      description: "",
      parameters: { type: "object", properties: {} },
      tags: ["browser", "vision"],
      handler: async () => ({ success: true, output: "" }),
    });

    const all = executor.getToolDefinitions();
    expect(all).toHaveLength(3);

    const fileOnly = executor.getToolDefinitions(["file"]);
    expect(fileOnly).toHaveLength(1);
    expect(fileOnly[0].name).toBe("file_tool");

    const browserAndVision = executor.getToolDefinitions(["browser", "vision"]);
    expect(browserAndVision).toHaveLength(1);
    expect(browserAndVision[0].name).toBe("browser_tool");

    const fileAndShell = executor.getToolDefinitions(["file", "shell"]);
    expect(fileAndShell.map((t) => t.name).sort()).toEqual(["file_tool", "shell_tool"]);
  });
});
