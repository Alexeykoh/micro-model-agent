import { describe, it, expect, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AgentDeps } from "../../src/core/agent/deps";
import type { TurnSummary } from "../../src/modules/types";

/**
 * S6 (спека 0.25.2): форс-финал (failed_batches / stalled / duplicate / silent /
 * cost / max_iters) проходит критика, но раньше МИНУЛ детерминированный аудит
 * плана — самый рискованный ход оставался единственным непроверенным.
 */

function createMockDeps(chatImpl: (...args: any[]) => AsyncGenerator<any>) {
  const mockProvider = {
    model: "test-model",
    contextWindow: 4096,
    chat: vi.fn().mockImplementation(chatImpl),
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
    setHarnessSink: vi.fn(),
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

  const deps = {
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
  } as AgentDeps;
  return { deps, provider: mockProvider, pluginManager: mockPluginManager, summaries };
}

function forceFinalChat(forceText: string) {
  return (_h: unknown, tools: unknown[]) =>
    (async function* () {
      if (Array.isArray(tools) && tools.length === 0) {
        yield { type: "text" as const, content: forceText };
        yield { type: "done" as const, finishReason: "stop" as const };
      } else {
        yield {
          type: "tool_call" as const,
          toolCall: { id: "t1", name: "bash", arguments: JSON.stringify({ command: "x" }) },
        };
        yield { type: "done" as const, finishReason: "tool_calls" as const };
      }
    })();
}

function setupFailedBatch(forceText: string) {
  const t = createMockDeps(forceFinalChat(forceText));
  t.deps.config.maxToolIterations = 20;
  t.deps.toolExecutor.getToolDefinitions.mockReturnValue([
    { name: "bash", description: "run a command", parameters: {} },
  ]);
  t.deps.toolExecutor.execute = async () => ({ success: false, output: "boom" });
  return t;
}

describe("force-final audit gate (S6)", () => {
  it("does not succeed when the audit fails on a failed-batch force-final", async () => {
    const t = setupFailedBatch("best effort after failures");
    t.deps.finalAudit = async () => ({
      passed: false,
      done: 0,
      total: 1,
      pendingSteps: ["1. unfinished step"],
      missingFiles: [],
      summary: "Task incomplete",
    });

    const agent = new Agent(t.deps);
    const result = await agent.run("task");

    expect(result.stopReason).toBe("failed_batches");
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("succeeds when the audit passes", async () => {
    const t = setupFailedBatch("best effort after failures");
    t.deps.finalAudit = async () => ({
      passed: true,
      done: 1,
      total: 1,
      pendingSteps: [],
      missingFiles: [],
      summary: "Task complete",
    });

    const agent = new Agent(t.deps);
    const result = await agent.run("task");

    expect(result.stopReason).toBe("failed_batches");
    expect(result.success).toBe(true);
  });
});
