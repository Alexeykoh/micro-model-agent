import { describe, it, expect, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";

function createMockDeps(overrides?: Record<string, unknown>) {
  const mockProvider = {
    model: "test-model",
    contextWindow: 4096,
    chat: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: "text" as const, content: "Hello from mock LLM" };
        yield { type: "done" as const, finishReason: "stop" as const };
      })(),
    ),
    countTokens: vi.fn().mockReturnValue(10),
  };

  const mockToolExecutor = {
    execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
    getToolDefinitions: vi.fn().mockReturnValue([]),
  };

  const mockPluginManager = {
    getAllPlugins: vi.fn().mockReturnValue([]),
    runOnBeforeThink: vi.fn(),
    runOnBeforeTool: vi.fn().mockResolvedValue(true),
    runOnAfterTool: vi.fn(),
    runOnToolCall: vi.fn(),
    runOnError: vi.fn(),
    runOnSessionStart: vi.fn(),
    runOnSessionEnd: vi.fn(),
  };

  const mockContextManager = {
    addMessage: vi.fn(),
    getMessageCount: vi.fn().mockReturnValue(0),
    needsCompaction: vi.fn().mockReturnValue(false),
    compact: vi.fn(),
    getActiveHistory: vi.fn().mockReturnValue([]),
    getEstimatedTokens: vi.fn().mockReturnValue(50),
    getBudget: vi.fn().mockReturnValue({
      systemPrompt: 1024,
      responseReserve: 512,
      history: 2560,
    }),
  };

  const mockHallucinationDetector = {
    validate: vi.fn().mockReturnValue({ status: "pass" as const }),
  };

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const config: AppConfig = {
    version: "2.0.0",
    model: "test-model",
    provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
    orchestrator: {},
    moe: { enabled: false },
    experts: {},
    contextWindow: 4096,
    contextBudget: {
      systemPrompt: 0.25,
      responseReserve: 0.12,
      compactionThreshold: 0.75,
    },
    modelLoad: { autoLoad: false },
    retry: { maxRetries: 3, baseDelay: 1000, maxDelay: 30000 },
    maxToolIterations: 5,
    stuckThreshold: 8,
    autoPlan: true,
    showReasoning: true,
    logLevel: "info",
    locale: "en",
    session: { autoSave: true, maxSessions: 50, isolateMemory: false },
    browser: {
      enabled: true,
      headless: true,
      maxElements: 30,
      viewportWidth: 1280,
      viewportHeight: 720,
      navigationTimeout: 15000,
    },
    mcpServers: {},
  };

  return {
    config,
    llmProvider: mockProvider,
    toolExecutor: mockToolExecutor,
    pluginManager: mockPluginManager,
    contextManager: mockContextManager,
    hallucinationDetector: mockHallucinationDetector,
    logger: mockLogger,
    baseDir: "/tmp",
    promptBlocks: [],
    ...overrides,
  };
}

describe("Agent", () => {
  it("returns text response for simple text LLM output", async () => {
    const deps = createMockDeps();
    const agent = new Agent(deps as any);
    const result = await agent.run("hello");
    expect(result.text).toBe("Hello from mock LLM");
    expect(result.success).toBe(true);
  });

  it("executes tool calls and continues loop", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: { id: "call-1", name: "test_tool", arguments: "{}" },
            };
            yield {
              type: "done" as const,
              finishReason: "tool_calls" as const,
            };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "Done after tool" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "tool executed",
        toolCallId: "call-1",
      }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
    };

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("do something");
    expect(result.text).toBe("Done after tool");
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);

    const assistantMsg = deps.contextManager.addMessage.mock.calls.find(
      (call: any) => call[0].role === "assistant" && call[0].tool_calls,
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg![0].tool_calls[0].id).toBe("call-1");

    const toolMsg = deps.contextManager.addMessage.mock.calls.find(
      (call: any) =>
        call[0].role === "tool" && call[0].tool_call_id === "call-1",
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg![0].name).toBe("test_tool");
  });

  it("limits max iterations and returns partial result", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: "tool_call" as const,
            toolCall: { id: "call-x", name: "test_tool", arguments: "{}" },
          };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "tool ok",
        toolCallId: "call-x",
      }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
    };

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
      config: { ...createMockDeps().config, maxToolIterations: 2 },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("loop forever");
    expect(result.success).toBe(false);
    expect(result.error).toContain("iteration");
  });

  it("hallucination block prevents tool execution", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "text" as const, content: "I will delete everything" };
          yield { type: "done" as const, finishReason: "stop" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const detector = {
      validate: vi.fn().mockReturnValue({
        status: "block" as const,
        reason: "Dangerous action detected",
      }),
    };

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      hallucinationDetector: detector as any,
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("delete everything");
    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked");
  });

  it("streams reasoning via onMeta when showReasoning is true", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "reasoning" as const, content: "Let me think..." };
          yield { type: "text" as const, content: "Answer" };
          yield { type: "done" as const, finishReason: "stop" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const deps = createMockDeps({ llmProvider: mockProvider as any });
    const agent = new Agent(deps as any);
    const meta: string[] = [];
    const text: string[] = [];
    await agent.run(
      "test",
      (c) => text.push(c),
      (m) => meta.push(m),
    );

    expect(meta.some((c) => c.includes("Let me think"))).toBe(true);
    expect(text.some((c) => c.includes("Answer"))).toBe(true);
    expect(text.some((c) => c.includes("Let me think"))).toBe(false);
  });

  it("hides reasoning when showReasoning is false", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "reasoning" as const, content: "Hidden thought" };
          yield { type: "text" as const, content: "Visible" };
          yield { type: "done" as const, finishReason: "stop" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const config = createMockDeps().config;
    config.showReasoning = false;
    const deps = createMockDeps({ llmProvider: mockProvider as any, config });
    const agent = new Agent(deps as any);
    const meta: string[] = [];
    await agent.run("test", undefined, (m) => meta.push(m));

    expect(meta.some((c) => c.includes("Hidden thought"))).toBe(false);
  });

  it("truncateToolOutput respects absolute max chars limit", () => {
    const deps = createMockDeps();
    const agent = new Agent(deps as any);
    const longOutput = "x".repeat(20000);
    const budget = { history: 20480 };
    const currentTokens = 5000;

    const result = (agent as any).truncateToolOutput(
      longOutput,
      budget,
      currentTokens,
    );
    expect(result.length).toBeLessThanOrEqual(15100);
    expect(result).toContain("Truncated");
  });

  it("truncateToolOutput does not truncate short output", () => {
    const deps = createMockDeps();
    const agent = new Agent(deps as any);
    const shortOutput = "Hello world";
    const budget = { history: 20480 };
    const currentTokens = 5000;

    const result = (agent as any).truncateToolOutput(
      shortOutput,
      budget,
      currentTokens,
    );
    expect(result).toBe(shortOutput);
  });

  it("truncateToolOutput respects remaining budget", () => {
    const deps = createMockDeps();
    const agent = new Agent(deps as any);
    const longOutput = "x".repeat(10000);
    const budget = { history: 20480 };
    const currentTokens = 19000;

    const result = (agent as any).truncateToolOutput(
      longOutput,
      budget,
      currentTokens,
    );
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain("Truncated");
  });

  it("filters tool definitions by toolTags when set", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
    };

    const deps = createMockDeps({
      toolExecutor: mockExecutor as any,
      toolTags: ["file", "code"],
    });
    const agent = new Agent(deps as any);
    await agent.run("hello");

    expect(mockExecutor.getToolDefinitions).toHaveBeenCalledWith([
      "file",
      "code",
    ]);
  });

  it("does not filter tools when toolTags is not set", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
    };

    const deps = createMockDeps({ toolExecutor: mockExecutor as any });
    const agent = new Agent(deps as any);
    await agent.run("hello");

    expect(mockExecutor.getToolDefinitions).toHaveBeenCalledWith(undefined);
  });

  it("delegates to single-agent loop when moe is disabled", async () => {
    const deps = createMockDeps({
      config: { ...createMockDeps().config, moe: { enabled: false } },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("hello");
    expect(result.text).toBe("Hello from mock LLM");
    expect(result.success).toBe(true);
  });
});
