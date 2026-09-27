import { describe, it, expect, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";

function textGen(text: string) {
  return async function* () {
    yield { type: "text" as const, content: text };
    yield { type: "done" as const, finishReason: "stop" as const };
  };
}

function createDeps(overrides?: Record<string, unknown>) {
  const capturedOptions: Array<Record<string, unknown> | undefined> = [];
  const mockProvider = {
    model: "test-model",
    contextWindow: 4096,
    chat: vi.fn().mockImplementation(
      (_history: unknown, _tools: unknown, _signal: unknown, options?: Record<string, unknown>) => {
        capturedOptions.push(options);
        return textGen("final answer")();
      },
    ),
    countTokens: vi.fn().mockReturnValue(10),
  };

  const config: AppConfig = {
    version: "2.0.0",
    model: "test-model",
    provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
    orchestrator: {},
    moe: { enabled: false },
    experts: {},
    contextWindow: 4096,
    contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
    modelLoad: { autoLoad: false },
    retry: { maxRetries: 3, baseDelay: 1000, maxDelay: 30000 },
    maxToolIterations: 5,
    stuckThreshold: 8,
    autoPlan: false,
    showReasoning: true,
    logLevel: "info",
    locale: "en",
    session: { autoSave: true, maxSessions: 50, isolateMemory: false },
    tools: { defaultTags: ["file", "code"], enableOnDemand: true },
    updater: { enabled: false, checkOnStart: false, autoInstall: false, intervalMs: 0 },
    reasoning: { mode: "auto", min: "low", max: "max", overrideCooldown: 5 },
  };

  const noop = () => {};
  const deps = {
    config,
    llmProvider: mockProvider,
    toolExecutor: {
      execute: vi.fn().mockResolvedValue({ success: true, output: "ok" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    },
    pluginManager: {
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
      runOnText: vi.fn((_c: unknown, chunk: string) => chunk),
      runOnMeta: vi.fn((_c: unknown, chunk: string) => chunk),
      runOnError: vi.fn(),
      runOnSessionStart: vi.fn(),
      runOnSessionEnd: vi.fn(),
      runOnTurnEnd: vi.fn(),
      setHostBridge: vi.fn(),
    },
    contextManager: {
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
      getKnownFiles: vi.fn().mockReturnValue([]),
      noteIteration: vi.fn(),
      setToolTokens: vi.fn(),
      thinkingLevel: undefined as string | undefined,
    },
    hallucinationDetector: {
      validate: vi.fn().mockReturnValue({ status: "pass" as const }),
      addKnownFiles: vi.fn(),
      getConfidenceCheck: vi.fn().mockReturnValue({ setPreviousResponse: vi.fn() }),
      getConsistencyCheck: vi.fn().mockReturnValue({
        trackDecision: noop,
        trackCreatedFile: noop,
        trackDeletedFile: noop,
      }),
    },
    logger: {
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
    },
    baseDir: "/tmp",
    promptBlocks: [],
    ...overrides,
  };
  return { deps, capturedOptions };
}

describe("Agent reasoning override", () => {
  it("applies a set_thinking override to the LLM call while active", async () => {
    const { deps, capturedOptions } = createDeps({ reasoningProbePassed: true });
    const agent = new Agent(deps as any);
    agent.reasoningState.level = "high";
    agent.reasoningState.overrideIteration = 0;

    await agent.run("hello");

    expect(capturedOptions[0]?.reasoningEffort).toBe("high");
  });

  it("override expires after overrideCooldown iterations", async () => {
    const { deps, capturedOptions } = createDeps({ reasoningProbePassed: true });
    const agent = new Agent(deps as any);
    // Set at "iteration -10": far outside the cooldown window of 5.
    agent.reasoningState.overrideIteration = -10;

    await agent.run("hello");

    // Expired override falls back to the policy baseline (config `min` = low).
    expect(capturedOptions[0]?.reasoningEffort).toBe("low");
  });

  it("manual override from setReasoningLevel persists (no cooldown)", async () => {
    const { deps, capturedOptions } = createDeps({ reasoningProbePassed: true });
    const agent = new Agent(deps as any);
    agent.setReasoningLevel("max");

    await agent.run("hello");

    expect(capturedOptions[0]?.reasoningEffort).toBe("max");
  });

  it("setReasoningLevel('auto') clears the manual override", async () => {
    const { deps, capturedOptions } = createDeps({ reasoningProbePassed: true });
    const agent = new Agent(deps as any);
    agent.setReasoningLevel("max");
    agent.setReasoningLevel("auto");

    await agent.run("hello");

    // Back to the auto policy baseline (config `min` = low).
    expect(capturedOptions[0]?.reasoningEffort).toBe("low");
  });

  it("previous-iteration hallucination retry reaches the policy raise branch", async () => {
    const validate = vi
      .fn()
      .mockReturnValueOnce({ status: "retry" as const, reason: "empty" })
      .mockReturnValue({ status: "pass" as const });
    const { deps, capturedOptions } = createDeps({ reasoningProbePassed: true });
    (deps.hallucinationDetector as any).validate = validate;
    const agent = new Agent(deps as any);

    await agent.run("hello");

    // Iteration 1: baseline (low). Iteration 2 (after retry): raised high.
    expect(capturedOptions.length).toBe(2);
    expect(capturedOptions[0]?.reasoningEffort).toBe("low");
    expect(capturedOptions[1]?.reasoningEffort).toBe("high");
  });

  it("an explicit baseline overrides the `min` fallback", async () => {
    const { deps, capturedOptions } = createDeps({ reasoningProbePassed: true });
    (deps.config as AppConfig).reasoning!.baseline = "high";
    const agent = new Agent(deps as any);

    await agent.run("hello");

    expect(capturedOptions[0]?.reasoningEffort).toBe("high");
  });

  it("falls back to the configured min when baseline is unset", async () => {
    const { deps, capturedOptions } = createDeps({ reasoningProbePassed: true });
    (deps.config as AppConfig).reasoning!.baseline = undefined;
    (deps.config as AppConfig).reasoning!.min = "none";
    const agent = new Agent(deps as any);

    await agent.run("hello");

    expect(capturedOptions[0]?.reasoningEffort).toBe("none");
  });
});
