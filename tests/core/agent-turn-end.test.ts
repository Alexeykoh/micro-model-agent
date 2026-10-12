import { describe, it, expect, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import type { TurnSummary } from "../../src/modules/types";

function createMockDeps(chatImpl?: () => AsyncGenerator<any>) {
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

describe("Agent onTurnEnd", () => {
  it("fires once per successful run with summary", async () => {
    const t = createMockDeps();
    const agent = new Agent(t.deps);
    const result = await agent.run("hello");

    expect(result.text).toBe("Hello from mock LLM");
    expect(t.pluginManager.runOnTurnEnd).toHaveBeenCalledTimes(1);
    const [, summary] = t.pluginManager.runOnTurnEnd.mock.calls[0];
    expect(summary.success).toBe(true);
    expect(summary.textLength).toBe("Hello from mock LLM".length);
    expect(summary.toolCalls).toBe(0);
    expect(summary.interrupted).toBeUndefined();
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("counts tool calls in the summary", async () => {
    let call = 0;
    const t = createMockDeps(() =>
      (async function* () {
        if (call++ === 0) {
          yield {
            type: "tool_call" as const,
            toolCall: { id: "t1", name: "bash", arguments: "{}" },
          };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        } else {
          yield { type: "text" as const, content: "done" };
          yield { type: "done" as const, finishReason: "stop" as const };
        }
      })(),
    );
    const agent = new Agent(t.deps);
    await agent.run("use tool");

    expect(t.pluginManager.runOnTurnEnd).toHaveBeenCalledTimes(1);
    const [, summary] = t.pluginManager.runOnTurnEnd.mock.calls[0];
    expect(summary.toolCalls).toBe(1);
    expect(summary.success).toBe(true);
  });

  it("fires with success:false when the LLM errors out", async () => {
    const t = createMockDeps(() =>
      (async function* () {
        yield { type: "error" as const, error: new Error("LLM down") };
      })(),
    );
    const agent = new Agent(t.deps);
    const result = await agent.run("boom");
    expect(result.success).toBe(false);
    expect(t.pluginManager.runOnTurnEnd).toHaveBeenCalledTimes(1);
    const [, summary] = t.pluginManager.runOnTurnEnd.mock.calls[0];
    expect(summary.success).toBe(false);
  });

  it("marks an interrupted run as interrupted (not ok)", async () => {
    const t = createMockDeps(() =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 60));
        yield { type: "text" as const, content: "partial" };
        yield { type: "done" as const, finishReason: "stop" as const };
      })(),
    );
    const agent = new Agent(t.deps);
    const p = agent.run("long");
    setTimeout(() => agent.shutdown(), 5);
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.interrupted).toBe(true);
    const [, summary] = t.pluginManager.runOnTurnEnd.mock.calls[0];
    expect(summary.interrupted).toBe(true);
  });
});
