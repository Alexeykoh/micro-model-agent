import { describe, it, expect, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import type { TurnSummary } from "../../src/modules/types";
import { createLoopState } from "../../src/core/agent/loop-state";

function createMockDeps(chatImpl?: (...args: any[]) => AsyncGenerator<any>) {
  const mockProvider = {
    model: "test-model",
    contextWindow: 4096,
    chat: vi.fn().mockImplementation(
      chatImpl ??
        (() =>
          (async function* () {
            yield { type: "text" as const, content: "Hello from mock LLM" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })()),
    ),
    countTokens: vi.fn().mockReturnValue(10),
  };

  const mockToolExecutor = {
    execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
    getToolDefinitions: vi.fn().mockReturnValue([]),
    getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
  };

  const summaries: TurnSummary[] = [];
  const mockPluginManager = {
    getAllPlugins: vi.fn().mockReturnValue([]),
    runOnBuildPrompt: vi.fn().mockReturnValue([]),
    runOnBeforeThink: vi.fn(),
    runOnBeforeTool: vi.fn().mockResolvedValue(true),
    runOnAfterTool: vi.fn(),
    runOnAfterThink: vi.fn(),
    runOnToolCall: vi.fn(),
    runOnPhase: vi.fn(),
    runOnToolStart: vi.fn(),
    runOnToolEnd: vi.fn(),
    runOnText: vi.fn().mockImplementation((_c: unknown, chunk: string) => chunk),
    runOnMeta: vi.fn().mockImplementation((_c: unknown, chunk: string) => chunk),
    runOnError: vi.fn(),
    runOnSessionStart: vi.fn(),
    runOnSessionEnd: vi.fn(),
    runOnTurnEnd: vi.fn().mockImplementation((_c: unknown, s: TurnSummary) => summaries.push(s)),
    setHostBridge: vi.fn(),
  };

  const mockContextManager = {
    addMessage: vi.fn(),
    getMessageCount: vi.fn().mockReturnValue(0),
    needsCompaction: vi.fn().mockReturnValue(false),
    compact: vi.fn(),
    getActiveHistory: vi.fn().mockReturnValue([]),
    getEstimatedTokens: vi.fn().mockReturnValue(50),
    getBudget: vi.fn().mockReturnValue({ systemPrompt: 1024, responseReserve: 512, history: 2560 }),
    updateSystemPrompt: vi.fn(),
    getCompactionCount: vi.fn().mockReturnValue(0),
    getIterationsSinceCompaction: vi.fn().mockReturnValue(0),
    getQuality: vi.fn().mockReturnValue(100),
    noteIteration: vi.fn(),
    setToolTokens: vi.fn(),
    resetUserTurn: vi.fn(),
  };

  const mockHallucinationDetector = {
    validate: vi.fn().mockReturnValue({ status: "pass" as const }),
    getConfidenceCheck: vi.fn().mockReturnValue({ setPreviousResponse: vi.fn() }),
    getConsistencyCheck: vi.fn().mockReturnValue({
      trackDecision: vi.fn(),
      trackCreatedFile: vi.fn(),
      trackDeletedFile: vi.fn(),
    }),
  };

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    diagnostic: vi.fn(),
    logLLMRequest: vi.fn(),
    logLLMResponse: vi.fn(),
    logToolCall: vi.fn(),
    logToolOutput: vi.fn(),
    initSessionLog: vi.fn(),
    closeSessionLog: vi.fn(),
    setSessionDir: vi.fn(),
  };

  return {
    deps: {
      config: {
        version: "2.0.0",
        model: "test-model",
        provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
        orchestrator: {},
        moe: { enabled: false },
        experts: {},
        contextWindow: 4096,
        contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
        modelLoad: { autoLoad: false },
        retry: { maxRetries: 1, baseDelay: 10, maxDelay: 20 },
        maxToolIterations: 5,
        stuckThreshold: 8,
        autoPlan: false,
        showReasoning: true,
        logLevel: "info",
        locale: "en",
        session: { autoSave: true, maxSessions: 50, isolateMemory: false },
      },
      llmProvider: mockProvider,
      toolExecutor: mockToolExecutor,
      pluginManager: mockPluginManager,
      contextManager: mockContextManager,
      hallucinationDetector: mockHallucinationDetector,
      logger: mockLogger,
      baseDir: "/tmp",
      promptBlocks: [],
    },
    provider: mockProvider,
    pluginManager: mockPluginManager,
    summaries,
  } as any;
}

function textThenDone(text: string) {
  return () =>
    (async function* () {
      yield { type: "text" as const, content: text };
      yield { type: "done" as const, finishReason: "stop" as const };
    })();
}

describe("Agent.finalizeWithoutTools", () => {
  it("produces a final answer via a tool-less call and marks success", async () => {
    const t = createMockDeps(textThenDone("Final answer from gathered evidence."));
    const agent = new Agent(t.deps);
    const state = createLoopState();
    state.iteration = 3;
    const chunks: string[] = [];
    const text = await (agent as any).finalizeWithoutTools(state, (c: string) => chunks.push(c));
    expect(text).toContain("Final answer");
    expect(chunks.join("")).toContain("Final answer");
    expect(state.lastText).toContain("Final answer");
    expect(state.finalAnswerAccepted).toBe(true);
    const tools = t.provider.chat.mock.calls.at(-1)![1];
    expect(tools).toEqual([]);
  });

  it("leaves finalAnswerAccepted false when the model returns nothing", async () => {
    const t = createMockDeps(() => (async function* () {})());
    const agent = new Agent(t.deps);
    const state = createLoopState();
    state.iteration = 3;
    await (agent as any).finalizeWithoutTools(state);
    expect(state.finalAnswerAccepted).toBe(false);
    expect(state.lastText).toBe("");
  });

  it("duplicate terminal yields a final answer with stopReason=duplicate and success", async () => {
    const t = createMockDeps((_h: unknown, tools: unknown[]) =>
      (async function* () {
        if (Array.isArray(tools) && tools.length === 0) {
          yield { type: "text" as const, content: "forced final answer" };
          yield { type: "done" as const, finishReason: "stop" as const };
        } else {
          yield {
            type: "tool_call" as const,
            toolCall: { id: "t1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
          };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        }
      })());
    t.deps.config.maxToolIterations = 20;
    t.deps.toolExecutor.getToolDefinitions.mockReturnValue([
      { name: "read_file", description: "read a file", parameters: {} },
    ]);
    const agent = new Agent(t.deps);
    const result = await agent.run("task");
    expect(result.stopReason).toBe("duplicate");
    expect(result.success).toBe(true);
    expect(result.text).toContain("forced final answer");
  });

  it("duplicate terminal with an empty forced answer is a failure", async () => {
    const t = createMockDeps((_h: unknown, tools: unknown[]) =>
      (async function* () {
        if (Array.isArray(tools) && tools.length === 0) {
          yield { type: "done" as const, finishReason: "stop" as const };
        } else {
          yield {
            type: "tool_call" as const,
            toolCall: { id: "t1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
          };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        }
      })());
    t.deps.config.maxToolIterations = 20;
    t.deps.toolExecutor.getToolDefinitions.mockReturnValue([
      { name: "read_file", description: "read a file", parameters: {} },
    ]);
    const agent = new Agent(t.deps);
    const result = await agent.run("task");
    expect(result.stopReason).toBe("duplicate");
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("failed-batch terminal forces a final answer", async () => {
    const t = createMockDeps((_h: unknown, tools: unknown[]) =>
      (async function* () {
        if (Array.isArray(tools) && tools.length === 0) {
          yield { type: "text" as const, content: "best effort after failures" };
          yield { type: "done" as const, finishReason: "stop" as const };
        } else {
          yield { type: "tool_call" as const, toolCall: { id: "t1", name: "bash", arguments: JSON.stringify({ command: "x" }) } };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        }
      })());
    t.deps.config.maxToolIterations = 20;
    t.deps.toolExecutor.getToolDefinitions.mockReturnValue([
      { name: "bash", description: "run a command", parameters: {} },
    ]);
    t.deps.toolExecutor.execute = async () => ({ success: false, output: "boom" });
    const agent = new Agent(t.deps);
    const result = await agent.run("task");
    expect(result.stopReason).toBe("failed_batches");
    expect(result.success).toBe(true);
    expect(result.text).toContain("best effort");
  });

  it("max-iterations exhaustion forces a final answer", async () => {
    let n = 0;
    const t = createMockDeps((_h: unknown, tools: unknown[]) =>
      (async function* () {
        if (Array.isArray(tools) && tools.length === 0) {
          yield { type: "text" as const, content: "final at iteration cap" };
          yield { type: "done" as const, finishReason: "stop" as const };
        } else {
          yield { type: "tool_call" as const, toolCall: { id: "t" + n, name: "read_file", arguments: JSON.stringify({ path: "f" + n++ + ".ts" }) } };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        }
      })());
    t.deps.config.maxToolIterations = 3;
    t.deps.toolExecutor.getToolDefinitions.mockReturnValue([
      { name: "read_file", description: "read a file", parameters: {} },
    ]);
    const agent = new Agent(t.deps);
    const result = await agent.run("task");
    expect(result.stopReason).toBe("max_iters");
    expect(result.success).toBe(true);
    expect(result.text).toContain("final at iteration cap");
  });
});
