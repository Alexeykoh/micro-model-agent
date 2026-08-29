import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";

vi.mock("../../src/core/agent-moe", () => ({
  runWithMoE: vi.fn(),
}));

import { runWithMoE } from "../../src/core/agent-moe";

const mockRunWithMoE = runWithMoE as unknown as ReturnType<typeof vi.fn>;

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
    getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    setScope: vi.fn(),
  };

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
    runOnText: vi.fn().mockImplementation((_ctx: unknown, chunk: string) => chunk),
    runOnMeta: vi.fn().mockImplementation((_ctx: unknown, chunk: string) => chunk),
    runOnError: vi.fn(),
    runOnSessionStart: vi.fn(),
    runOnSessionEnd: vi.fn(),
    runOnTurnEnd: vi.fn(),
    setHostBridge: vi.fn(),
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
    updateSystemPrompt: vi.fn(),
    getCompactionCount: vi.fn().mockReturnValue(0),
    getIterationsSinceCompaction: vi.fn().mockReturnValue(0),
    getQuality: vi.fn().mockReturnValue(100),
    noteIteration: vi.fn(),
    setToolTokens: vi.fn(),
    resetUserTurn: vi.fn(),
  };

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logLLMRequest: vi.fn(),
    logLLMResponse: vi.fn(),
    logToolCall: vi.fn(),
    logToolOutput: vi.fn(),
    initSessionLog: vi.fn(),
    closeSessionLog: vi.fn(),
    setSessionDir: vi.fn(),
  };

  const config: AppConfig = {
    version: "2.0.0",
    model: "test-model",
    provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
    orchestrator: {},
    moe: { enabled: true },
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
      maxContentChars: 2500,
      maxConsoleEntries: 20,
      maxConsoleLineChars: 400,
      viewportWidth: 1280,
      viewportHeight: 720,
      navigationTimeout: 15000,
    },
    mcpServers: {},
    ui: {
      spinner: true,
      toolStyle: "inline",
      toolComments: true,
      showContextStats: false,
      showCompaction: false,
    },
    skills: { budget: 8000 },
    tools: { defaultTags: ["file", "code"], enableOnDemand: true },
    subagent: {
      resultMode: "text",
      maxSummaryChars: 2000,
      artifactsDir: ".mma/artifacts",
      stableSystemPrompt: true,
      maxParallelChunkQueries: 3,
    },
    updater: { enabled: false, checkOnStart: false, autoInstall: false, intervalMs: 0 },
  };

  return {
    config,
    llmProvider: mockProvider,
    toolExecutor: mockToolExecutor,
    pluginManager: mockPluginManager,
    contextManager: mockContextManager,
    hallucinationDetector: {
      validate: vi.fn().mockReturnValue({ status: "pass" as const }),
      getConfidenceCheck: vi.fn().mockReturnValue({ setPreviousResponse: vi.fn() }),
      getConsistencyCheck: vi.fn().mockReturnValue({
        trackDecision: vi.fn(),
        trackCreatedFile: vi.fn(),
        trackDeletedFile: vi.fn(),
      }),
    },
    logger: mockLogger,
    baseDir: "/tmp",
    promptBlocks: [],
    ...overrides,
  };
}

describe("Agent MoE write-back", () => {
  beforeEach(() => {
    mockRunWithMoE.mockReset();
  });

  it("writes the MoE result into context as an assistant turn", async () => {
    mockRunWithMoE.mockResolvedValue({
      success: true,
      text: "MoE final answer",
      iterationCount: 2,
      moeHandled: true,
    });
    const deps = createMockDeps();
    const agent = new Agent(deps as any);
    const result = await agent.run("task");

    expect(result.text).toBe("MoE final answer");
    const addMessage = deps.contextManager.addMessage as any;
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: "MoE final answer" }),
    );
  });

  it("does not double-write the assistant turn when MoE falls back", async () => {
    mockRunWithMoE.mockResolvedValue({
      success: true,
      text: "fallback answer",
      iterationCount: 1,
      // no moeHandled — the fallback single-agent loop wrote its own turn
    });
    const deps = createMockDeps();
    const agent = new Agent(deps as any);
    await agent.run("task");

    const addMessage = deps.contextManager.addMessage as any;
    const assistantWrites = addMessage.mock.calls.filter(
      (c: any[]) => c[0]?.role === "assistant" && c[0]?.content === "fallback answer",
    );
    expect(assistantWrites).toHaveLength(0);
  });
});
