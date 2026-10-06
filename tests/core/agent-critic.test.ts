import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AgentDeps } from "../../src/core/agent";

function createMockDeps(overrides: Partial<AgentDeps> = {}) {
  let call = 0;
  const messages: any[] = [];

  const provider = {
    model: "test-model",
    contextWindow: 4096,
    chat: vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return (async function* () {
          yield {
            type: "tool_call" as const,
            toolCall: {
              id: "t1",
              name: "write_file",
              arguments: JSON.stringify({ path: "src/a.ts", content: "x" }),
            },
          };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        })();
      }
      return (async function* () {
        yield { type: "text" as const, content: "final answer" };
        yield { type: "done" as const, finishReason: "stop" as const };
      })();
    }),
    countTokens: vi.fn().mockReturnValue(10),
    listModels: async () => [],
  };

  const contextManager = {
    addMessage: vi.fn((m: any) => messages.push(m)),
    getActiveHistory: vi.fn(() => messages),
    beginTurn: vi.fn(() => 0),
    getMessageCount: vi.fn(() => messages.length),
    needsCompaction: vi.fn().mockReturnValue(false),
    compact: vi.fn(),
    getEstimatedTokens: vi.fn().mockReturnValue(50),
    getBudget: vi.fn().mockReturnValue({ systemPrompt: 1024, responseReserve: 512, history: 2560 }),
    updateSystemPrompt: vi.fn(),
    getCompactionCount: vi.fn().mockReturnValue(0),
    getIterationsSinceCompaction: vi.fn().mockReturnValue(0),
    getQuality: vi.fn().mockReturnValue(100),
    noteIteration: vi.fn(),
    setToolTokens: vi.fn(),
    resetUserTurn: vi.fn(),
    clear: vi.fn(),
  };

  const deps = {
    config: {
      version: "2.0.0",
      model: "test-model",
      provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
      orchestrator: {},
      moe: { enabled: false },
      critic: { enabled: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 15000 },
      experts: {},
      contextWindow: 4096,
      contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
      modelLoad: { autoLoad: false },
      retry: { maxRetries: 1, baseDelay: 10, maxDelay: 20 },
      maxToolIterations: 5,
      stuckThreshold: 8,
      autoPlan: false,
      showReasoning: false,
      logLevel: "info",
      locale: "en",
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    },
    llmProvider: provider,
    toolExecutor: {
      execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
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
      runOnText: vi.fn().mockImplementation((_c: unknown, chunk: string) => chunk),
      runOnMeta: vi.fn().mockImplementation((_c: unknown, chunk: string) => chunk),
      runOnError: vi.fn(),
      runOnSessionStart: vi.fn(),
      runOnSessionEnd: vi.fn(),
      runOnTurnEnd: vi.fn(),
      setHostBridge: vi.fn(),
    },
    contextManager,
    hallucinationDetector: {
      validate: vi.fn().mockReturnValue({ status: "pass" as const }),
      getConfidenceCheck: vi.fn().mockReturnValue({ setPreviousResponse: vi.fn() }),
      getConsistencyCheck: vi.fn().mockReturnValue({
        trackDecision: vi.fn(),
        trackCreatedFile: vi.fn(),
        trackDeletedFile: vi.fn(),
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
  } as any;

  return { deps, provider, messages };
}

function userSummaries(messages: any[]): any[] {
  return messages.filter(
    (m) =>
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.startsWith("<system-summary>"),
  );
}

describe("Agent in-loop critic", () => {
  it("injects a system-summary and retries when the critic reports critical", async () => {
    const verify = vi.fn(async () => ({
      status: "critical" as const,
      summary: "broken",
      issues: [{ severity: "critical" as const, claim: "missing", problem: "missing file" }],
    }));
    const t = createMockDeps({ criticOverride: { verify } } as any);
    const agent = new Agent(t.deps);
    const result = await agent.run("do work");

    expect(result.success).toBe(true);
    expect(result.text).toBe("final answer");
    expect(verify).toHaveBeenCalledTimes(2);
    expect(t.provider.chat).toHaveBeenCalledTimes(3);
    expect(userSummaries(t.messages).length).toBe(2);
  });

  it("accepts normally when the critic returns ok", async () => {
    const verify = vi.fn(async () => ({ status: "ok" as const, summary: "fine", issues: [] }));
    const t = createMockDeps({ criticOverride: { verify } } as any);
    const agent = new Agent(t.deps);
    const result = await agent.run("do work");

    expect(result.success).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(t.provider.chat).toHaveBeenCalledTimes(2);
    expect(userSummaries(t.messages).length).toBe(1);
  });

  it("fails open when the critic throws", async () => {
    const verify = vi.fn(async () => {
      throw new Error("critic boom");
    });
    const t = createMockDeps({ criticOverride: { verify } } as any);
    const agent = new Agent(t.deps);
    const result = await agent.run("do work");

    expect(result.success).toBe(true);
    expect(t.provider.chat).toHaveBeenCalledTimes(2);
  });

  it("reports a fresh verdict through diagnostics instead of a chat UI callback", async () => {
    const verify = vi.fn(async () => ({
      status: "critical" as const,
      summary: "broken",
      issues: [{ severity: "critical" as const, claim: "missing", problem: "missing file" }],
    }));
    const t = createMockDeps({ criticOverride: { verify } } as any);
    const agent = new Agent(t.deps);
    await agent.run("do work");

    const calls = (t.deps.logger.diagnostic as any).mock.calls as any[];
    expect(calls.some((c) => c[0] === "info" && String(c[1]).includes("Critic critical: broken"))).toBe(
      true,
    );
    expect(calls.some((c) => String(c[1]).includes("repairing"))).toBe(false);
  });
});
