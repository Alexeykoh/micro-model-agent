import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Agent } from "../../src/core/agent";
import { truncateToolOutput } from "../../src/core/agent/tool-output";
import { LlmError } from "../../src/llm/llm-errors";
import { ModuleRegistry } from "../../src/modules/registry";
import { MemoryStore } from "../../src/modules/memory/store";
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
    getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
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
  };

  const mockHallucinationDetector = {
    validate: vi.fn().mockReturnValue({ status: "pass" as const }),
    getConfidenceCheck: vi.fn().mockReturnValue({
      setPreviousResponse: vi.fn(),
    }),
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
    hallucinationDetector: mockHallucinationDetector,
    logger: mockLogger,
    baseDir: "/tmp",
    promptBlocks: [],
    ...overrides,
  };
}

describe("Agent", () => {
  it("exposes getModule() for CLI access", () => {
    const deps = createMockDeps({
      moduleRegistry: new ModuleRegistry().register({ name: "lsp", getSystemPromptBlock: () => null }),
    });
    const agent = new Agent(deps as any);
    const mod = agent.getModule("lsp");
    expect(mod).toBeDefined();
    expect(agent.getModule("nope")).toBeUndefined();
  });

  it("callerProvenance prefers the live provider name (post-failover)", () => {
    const deps = createMockDeps({ getProviderName: () => "live" });
    const agent = new Agent(deps as any);
    expect(agent.callerProvenance()).toEqual({ provider: "live", model: "test-model" });
  });

  it("returns text response for simple text LLM output", async () => {
    const deps = createMockDeps();
    const agent = new Agent(deps as any);
    const result = await agent.run("hello");
    expect(result.text).toBe("Hello from mock LLM");
    expect(result.success).toBe(true);
  });

  it("awaits lazyPromptBlocks once and includes the block in the first system prompt", async () => {
    const lazyBlock = {
      content: "STARTUP-BASELINE: pre-existing errors",
      priority: "high" as const,
      essential: false,
      estimatedTokens: 5,
    };
    const lazyFn = vi.fn().mockResolvedValue([lazyBlock]);
    const deps = createMockDeps({ lazyPromptBlocks: lazyFn });
    const agent = new Agent(deps as any);

    await agent.run("hello");
    await agent.run("again");

    expect(lazyFn).toHaveBeenCalledTimes(1);
    const addMessage = deps.contextManager.addMessage as any;
    const systemCall = addMessage.mock.calls.find((c: any[]) => c[0].role === "system");
    expect(systemCall[0].content).toContain("STARTUP-BASELINE");
  });

  it("handles lazyPromptBlocks resolving to an empty array", async () => {
    const lazyFn = vi.fn().mockResolvedValue([]);
    const deps = createMockDeps({ lazyPromptBlocks: lazyFn });
    const agent = new Agent(deps as any);

    await agent.run("hello");

    expect(lazyFn).toHaveBeenCalledTimes(1);
  });

  it("estimates token metrics locally when the backend omits usage", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      // No `done` chunk with usage → api tokens stay 0 → local fallback
      chat: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "text" as const, content: "An answer of some length" };
          yield { type: "done" as const, finishReason: "stop" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const deps = createMockDeps({ llmProvider: mockProvider });
    const agent = new Agent(deps as any);
    const result = await agent.run("task");
    expect(result.success).toBe(true);
    // prompt falls back to the estimated context size (mock returns 50)
    expect(result.promptTokens).toBeGreaterThan(0);
    // completion falls back to chars/4 of the generated text
    expect(result.completionTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.promptTokens! + result.completionTokens!);
  });

  it("keeps the final text when exitOnComplete breaks on a retry-flagged response", async () => {    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: {
                id: "t1",
                name: "bash",
                arguments: "{}",
              },
            };
            yield {
              type: "done" as const,
              finishReason: "tool_calls" as const,
            };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "Done! check-env works" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const deps = createMockDeps({
      llmProvider: mockProvider,
      exitOnComplete: true,
      hallucinationDetector: {
        validate: vi
          .fn()
          .mockReturnValueOnce({ status: "pass" as const })
          .mockReturnValueOnce({ status: "retry" as const, reason: "short" }),
        getConfidenceCheck: vi.fn().mockReturnValue({
          setPreviousResponse: vi.fn(),
        }),
        getConsistencyCheck: vi.fn().mockReturnValue({
          trackDecision: vi.fn(),
          trackCreatedFile: vi.fn(),
          trackDeletedFile: vi.fn(),
        }),
      },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("run the check");
    // The retry-flagged final response must still be surfaced as the result
    expect(result.success).toBe(true);
    expect(result.text).toBe("Done! check-env works");
  });

  it("surfaces invalid tool_call arguments and warns instead of silently using {}", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: { id: "t1", name: "bash", arguments: "not-json{{" },
            };
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "recovered" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const deps = createMockDeps({ llmProvider: mockProvider, exitOnComplete: true });
    const agent = new Agent(deps as any);
    await agent.run("do it");

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid JSON in tool_call arguments"),
    );
    const addMessage = deps.contextManager.addMessage as any;
    const nudge = addMessage.mock.calls.find(
      (c: any[]) =>
        typeof c[0]?.content === "string" && c[0].content.includes("invalid JSON arguments"),
    );
    expect(nudge).toBeDefined();
  });

  it("exitOnComplete does not bypass the audit gate on a retry-flagged answer", async () => {
    const bashCall = {
      type: "tool_call" as const,
      toolCall: { id: "t1", name: "bash", arguments: "{}" },
    };
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield bashCall;
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        // Model answers "done" without finishing the plan — flagged retry.
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "Done!" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        )
        // After the retry nudge the model does the real work and finishes.
        .mockReturnValueOnce(
          (async function* () {
            yield bashCall;
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "Now actually complete" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const deps = createMockDeps({
      llmProvider: mockProvider,
      exitOnComplete: true,
      // Active plan → the audit gate must not be bypassed by the fast-exit.
      finalAudit: vi.fn().mockResolvedValue(null),
      hallucinationDetector: {
        // validate() runs only on text responses (tool-call responses skip it),
        // so the first call corresponds to the premature "Done!".
        validate: vi
          .fn()
          .mockReturnValueOnce({ status: "retry" as const, reason: "short" })
          .mockReturnValue({ status: "pass" as const }),
        getConfidenceCheck: vi.fn().mockReturnValue({
          setPreviousResponse: vi.fn(),
        }),
        getConsistencyCheck: vi.fn().mockReturnValue({
          trackDecision: vi.fn(),
          trackCreatedFile: vi.fn(),
          trackDeletedFile: vi.fn(),
        }),
      },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("finish the plan");
    // The premature "Done!" must NOT end the run: the model gets another
    // chance and the later substantive answer becomes the result.
    expect(mockProvider.chat).toHaveBeenCalledTimes(4);
    expect(result.text).toBe("Now actually complete");
  });

  it("gives the model a second chance after a repeated tool call under exitOnComplete", async () => {
    const bashCall = {
      type: "tool_call" as const,
      toolCall: { id: "t1", name: "bash", arguments: "{}" },
    };
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield bashCall;
            yield {
              type: "done" as const,
              finishReason: "tool_calls" as const,
            };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            // identical tool call again
            yield bashCall;
            yield {
              type: "done" as const,
              finishReason: "tool_calls" as const,
            };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "All done now" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const addMessage = vi.fn();
    const deps = createMockDeps({
      llmProvider: mockProvider,
      config: { ...createMockDeps().config, maxToolIterations: 20 },
      contextManager: {
        addMessage,
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
      },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("run twice");
    // The repeated call must NOT have stopped the run — the model got a
    // chance to answer and its final text is preserved.
    expect(mockProvider.chat).toHaveBeenCalledTimes(3);
    expect(
      addMessage.mock.calls.some(
        (c: any) =>
          typeof c[0]?.content === "string" &&
          c[0].content.includes("same tool with identical arguments"),
      ),
    ).toBe(true);
    expect(result.text).toBe("All done now");
  });

  it("does not hard-stop a legitimate repeated non-status tool under exitOnComplete", async () => {
    // Пользователь может явно попросить выполнить одну команду несколько раз;
    // повторный bash не должен обрывать прогон пустым ответом (регрессия:
    // запрос «run echo tick 4 times» завершался без вывода).
    const bashCall = {
      type: "tool_call" as const,
      toolCall: { id: "t1", name: "bash", arguments: '{"command":"echo tick"}' },
    };
    const gen = () =>
      (async function* () {
        yield bashCall;
        yield { type: "done" as const, finishReason: "tool_calls" as const };
      })();
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(gen())
        .mockReturnValueOnce(gen())
        .mockReturnValueOnce(gen())
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "ran 3 times" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const deps = createMockDeps({
      llmProvider: mockProvider,
      exitOnComplete: true,
      config: { ...createMockDeps().config, maxToolIterations: 20 },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("run echo tick 3 times");
    expect(mockProvider.chat).toHaveBeenCalledTimes(4);
    expect(result.text).toBe("ran 3 times");
  });

  it("nudges the model after a repeated tool call even without exitOnComplete", async () => {
    const bashCall = {
      type: "tool_call" as const,
      toolCall: { id: "t1", name: "bash", arguments: "{}" },
    };
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield bashCall;
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            // identical tool call again
            yield bashCall;
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "Done with a different approach" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const addMessage = vi.fn();
    const deps = createMockDeps({
      llmProvider: mockProvider,
      contextManager: {
        addMessage,
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
      },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("run twice");
    // Without exitOnComplete the run must not be aborted, but the model
    // still gets the nudge so it stops burning iterations on identical calls.
    expect(mockProvider.chat).toHaveBeenCalledTimes(3);
    expect(
      addMessage.mock.calls.some(
        (c: any) =>
          typeof c[0]?.content === "string" &&
          c[0].content.includes("same tool with identical arguments"),
      ),
    ).toBe(true);
    expect(result.text).toBe("Done with a different approach");
  });

  it("hard-stops an interactive run stuck on the same status tool", async () => {
    const infoCall = {
      type: "tool_call" as const,
      toolCall: { id: "t1", name: "session_info", arguments: "{}" },
    };
    const identical = () =>
      (async function* () {
        yield infoCall;
        yield { type: "done" as const, finishReason: "tool_calls" as const };
      })();
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockImplementation(identical),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const deps = createMockDeps({
      llmProvider: mockProvider,
      config: { ...createMockDeps().config, maxToolIterations: 20 },
    });
    const agent = new Agent(deps as any);
    await agent.run("loop forever");
    // Nudged on each repeat, then hard-stopped at
    // MAX_REPEATED_TOOL_CALLS_INTERACTIVE (5): never a 7th provider call.
    expect(mockProvider.chat).toHaveBeenCalledTimes(6);
  });

  it("nudges the model when one target is mutated repeatedly (perfectionism cycle)", async () => {
    // Alternating identical bash builds and distinct other-tool calls — the
    // consecutive-duplicate guard must NOT fire, but after the 5th mutation
    // of the same target the cycle guard injects a finalize-nudge.
    const stream = (chunk: object) =>
      (async function* () {
        yield chunk;
        yield { type: "done" as const, finishReason: "tool_calls" as const };
      })();
    const calls: object[] = [];
    for (let i = 0; i < 5; i++) {
      // Real providers deliver arguments as a raw JSON string — the loop
      // parses them into objects (chunk.toolCall.arguments → JSON.parse).
      calls.push(stream({
        type: "tool_call" as const,
        toolCall: { id: `b${i}`, name: "bash", arguments: JSON.stringify({ command: "node build.js" }) },
      }));
      calls.push(stream({
        type: "tool_call" as const,
        toolCall: { id: `r${i}`, name: "test_tool", arguments: JSON.stringify({ n: i }) },
      }));
    }
    calls.push(
      (async function* () {
        yield { type: "text" as const, content: "Finished polishing" };
        yield { type: "done" as const, finishReason: "stop" as const };
      })(),
    );
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockImplementation(() => calls.shift()!),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const addMessage = vi.fn();
    const deps = createMockDeps({
      llmProvider: mockProvider,
      config: { ...createMockDeps().config, maxToolIterations: 20 },
      contextManager: {
        addMessage,
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
      },
      toolExecutor: {
        execute: vi.fn(async (call: any) => ({
          success: true,
          output: "ok",
          toolCallId: call.id,
        })),
        getToolDefinitions: vi.fn().mockReturnValue([]),
        getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
      } as any,
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("build repeatedly");

    // 10 tool iterations + final answer — the run is NOT hard-stopped.
    expect(mockProvider.chat).toHaveBeenCalledTimes(11);
    expect(
      addMessage.mock.calls.some(
        (c: any) =>
          typeof c[0]?.content === "string" &&
          c[0].content.includes("same target many times"),
      ),
    ).toBe(true);
    expect(result.text).toBe("Finished polishing");
  });

  it("retries empty (reasoning-only) responses and returns the final text", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "reasoning" as const, content: "thinking..." };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "reasoning" as const, content: "still thinking..." };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "Final answer" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const deps = createMockDeps({ llmProvider: mockProvider });
    const agent = new Agent(deps as any);
    const result = await agent.run("task");
    expect(mockProvider.chat).toHaveBeenCalledTimes(3);
    expect(result.text).toBe("Final answer");
    expect(result.success).toBe(true);
  });

  it("returns success:false when empty responses exhaust retries", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "reasoning" as const, content: "thinking..." };
          yield { type: "done" as const, finishReason: "stop" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const deps = createMockDeps({ llmProvider: mockProvider });
    const agent = new Agent(deps as any);
    const result = await agent.run("task");
    // 1 initial + 2 retries, then exhausted
    expect(mockProvider.chat).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty");
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
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
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
      (call: any) => call[0].role === "tool" && call[0].tool_call_id === "call-1",
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
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
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

  it("reports success when the final answer lands on the last allowed iteration", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: { id: "call-x", name: "test_tool", arguments: "{}" },
            };
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "Final answer on last iteration" };
            yield { type: "done" as const, finishReason: "stop" as const };
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
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
      config: { ...createMockDeps().config, maxToolIterations: 2 },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("do it");
    expect(result.success).toBe(true);
    expect(result.text).toBe("Final answer on last iteration");
    expect(result.error).toBeUndefined();
  });

  it("truncates tool arguments in the <system-summary> envelope", async () => {
    const bigContent = "x".repeat(5000);
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: {
                id: "call-1",
                name: "write_file",
                arguments: JSON.stringify({ path: "a.ts", content: bigContent }),
              },
            };
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "done" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: "ok", toolCallId: "call-1" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };
    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
    });
    const agent = new Agent(deps as any);
    await agent.run("write big file");

    const addMessage = deps.contextManager.addMessage as any;
    const summaryText = addMessage.mock.calls
      .filter(
        (c: any[]) =>
          c[0]?.role === "user" &&
          typeof c[0]?.content === "string" &&
          c[0].content.startsWith("<system-summary>"),
      )
      .map((c: any[]) => c[0].content)
      .join("\n");
    // The full 5000-char content must NOT be duplicated into the envelope.
    expect(summaryText).not.toContain(bigContent);
    // The args summary is bounded (~240 chars + marker).
    expect(summaryText.length).toBeLessThan(1000);
  });

  it("converts a throwing tool into a failed result instead of killing the session", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: { id: "call-1", name: "bash", arguments: "{}" },
            };
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "recovered after tool throw" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const mockExecutor = {
      execute: vi.fn().mockRejectedValue(new Error("internal tool bug")),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };
    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("do something");

    // The session survives: the thrown tool became a failed result and the
    // model answered on the next iteration.
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.text).toBe("recovered after tool throw");

    const toolMsg = (deps.contextManager.addMessage as any).mock.calls.find(
      (c: any[]) => c[0]?.role === "tool" && c[0]?.tool_call_id === "call-1",
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg[0].success).toBe(false);
  });

  it("reports a cumulative prompt-token estimate when the backend omits usage", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: { id: "c1", name: "test_tool", arguments: "{}" },
            };
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "answer" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: "ok", toolCallId: "c1" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };
    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("two iterations");
    // Two LLM calls with no usage → the prompt estimate must be the SUM of the
    // per-iteration context sizes (50 + 50), not just the last snapshot.
    expect(result.promptTokens).toBe(100);
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
      getConfidenceCheck: vi.fn().mockReturnValue({
        setPreviousResponse: vi.fn(),
      }),
      getConsistencyCheck: vi.fn().mockReturnValue({
        trackDecision: vi.fn(),
        trackCreatedFile: vi.fn(),
        trackDeletedFile: vi.fn(),
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

  it("exitOnComplete does not break on empty text flagged as retry", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "reasoning" as const, content: "thinking..." };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "Final answer" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const detector = {
      validate: vi.fn().mockImplementation((text: string) => ({
        status: text?.trim() ? ("pass" as const) : ("retry" as const),
        reason: text?.trim() ? undefined : "empty response",
      })),
      getConfidenceCheck: vi.fn().mockReturnValue({
        setPreviousResponse: vi.fn(),
      }),
      getConsistencyCheck: vi.fn().mockReturnValue({
        trackDecision: vi.fn(),
        trackCreatedFile: vi.fn(),
        trackDeletedFile: vi.fn(),
      }),
    };

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      hallucinationDetector: detector as any,
      config: { ...createMockDeps().config, exitOnComplete: true },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("task");
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.text).toBe("Final answer");
  });

  it("feeds a recoverable LLM error back into context instead of dying", async () => {
    let call = 0;
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          const err = new LlmError(
            "Response hit the completion token limit (4096) mid tool_call",
            { recoverable: true },
          );
          throw err;
        }
        return (async function* () {
          yield { type: "text" as const, content: "Recovered answer" };
          yield { type: "done" as const, finishReason: "stop" as const };
        })();
      }),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const deps = createMockDeps({ llmProvider: mockProvider as any });
    const agent = new Agent(deps as any);
    const result = await agent.run("task");

    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.text).toBe("Recovered answer");
    // The localized error reason is fed back as a system-summary message.
    const addMessage = deps.contextManager.addMessage as any;
    expect(addMessage).toHaveBeenCalled();
    expect(
      addMessage.mock.calls.some(
        ([msg]: any[]) => msg?.role === "user" && msg?.content.includes("<system-summary>"),
      ),
    ).toBe(true);
  });

  it("gives up after MAX_LLM_ERROR_RETRIES recoverable errors", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockImplementation(() => {
        const err = new LlmError("Response hit the completion token limit (4096)", {
          recoverable: true,
        });
        throw err;
      }),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const deps = createMockDeps({ llmProvider: mockProvider as any });
    const agent = new Agent(deps as any);
    const result = await agent.run("task");

    // 1 initial + 2 retries, then the fatal path.
    expect(mockProvider.chat).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
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

  it("renders a provider warning via the text stream but keeps it out of the answer", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "text" as const, content: "partial answer" };
          yield {
            type: "warning" as const,
            content: "The response hit the completion token limit (4096) and was cut off",
          };
          yield { type: "done" as const, finishReason: "length" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const deps = createMockDeps({ llmProvider: mockProvider as any });
    const agent = new Agent(deps as any);
    const text: string[] = [];
    const result = await agent.run("test", (c) => text.push(c));

    expect(text.some((c) => c.includes("partial answer"))).toBe(true);
    expect(text.some((c) => c.includes("completion token limit"))).toBe(true);
    // The warning is UI-only: it must not pollute the accepted answer.
    expect(result.text).toBe("partial answer");
  });

  it("suppresses REPL output when a tool result has an empty display string", async () => {
    // read_file full read returns display "" — the fallback to raw output
    // would dump the whole file content into the terminal (regression).
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: { id: "t1", name: "read_file", arguments: '{"path":"a.ts"}' },
            };
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "read done" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const toolExecutor = {
      execute: vi
        .fn()
        .mockResolvedValue({ success: true, output: "── header\nFULL FILE BODY", display: "" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };
    const deps = createMockDeps({ llmProvider: mockProvider, toolExecutor });
    const agent = new Agent(deps as any);
    const meta: string[] = [];
    await agent.run("read it", undefined, (m) => meta.push(m));

    expect(meta.join("")).not.toContain("FULL FILE BODY");
  });

  it("shows the raw output when a tool result has no display field", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi
        .fn()
        .mockReturnValueOnce(
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: { id: "t1", name: "bash", arguments: "{}" },
            };
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "text" as const, content: "done" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
      countTokens: vi.fn().mockReturnValue(10),
    };
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: "plain tool output" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };
    const deps = createMockDeps({ llmProvider: mockProvider, toolExecutor });
    const agent = new Agent(deps as any);
    const meta: string[] = [];
    await agent.run("run it", undefined, (m) => meta.push(m));

    expect(meta.join("")).toContain("plain tool output");
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

  it("emits thinking/done phases around each LLM call", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "text" as const, content: "Answer" };
          yield { type: "done" as const, finishReason: "stop" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const deps = createMockDeps({ llmProvider: mockProvider as any });
    const agent = new Agent(deps as any);
    const phases: string[] = [];
    await agent.run("test", undefined, undefined, undefined, (p) => phases.push(p));

    expect(phases).toEqual(["thinking", "done"]);
  });

  it("emits done phase even when the LLM call throws", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue(
        (async function* () {
          throw new Error("boom");
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const deps = createMockDeps({ llmProvider: mockProvider as any });
    const agent = new Agent(deps as any);
    const phases: string[] = [];
    const result = await agent.run("test", undefined, undefined, undefined, (p) => phases.push(p));

    expect(phases).toEqual(["thinking", "done"]);
    expect(result.success).toBe(false);
  });

  it("dispatches onPhase to plugins", async () => {
    const deps = createMockDeps();
    const agent = new Agent(deps as any);
    await agent.run("test");

    const calls = (deps.pluginManager.runOnPhase as any).mock.calls;
    const phases = calls.map((c: any[]) => c[1]);
    expect(phases).toEqual(["thinking", "done"]);
  });

  it("dispatches onAfterThink with the parsed response", async () => {
    const deps = createMockDeps();
    const agent = new Agent(deps as any);
    await agent.run("test");

    const calls = (deps.pluginManager.runOnAfterThink as any).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toMatchObject({
      type: "text",
      content: "Hello from mock LLM",
    });
  });

  it("includes plugin prompt blocks from onBuildPrompt", async () => {
    const deps = createMockDeps({
      pluginManager: {
        ...createMockDeps().pluginManager,
        runOnBuildPrompt: vi.fn().mockReturnValue(["### Plugin rule: be brief"]),
      },
    });
    const agent = new Agent(deps as any);
    await agent.run("test");

    const added = deps.contextManager.addMessage as any;
    const systemMessage = added.mock.calls.find((c: any[]) => c[0]?.role === "system");
    expect(systemMessage).toBeDefined();
    expect(systemMessage[0].content).toContain("Plugin rule: be brief");
  });

  it("dispatches onToolStart and onToolEnd around tool execution", async () => {
    const deps = createMockDeps({
      llmProvider: {
        model: "test-model",
        contextWindow: 4096,
        chat: vi
          .fn()
          .mockReturnValueOnce(
            (async function* () {
              yield {
                type: "tool_call" as const,
                toolCall: {
                  id: "call_1",
                  name: "write_file",
                  arguments: "{}",
                },
              };
              yield {
                type: "done" as const,
                finishReason: "tool_calls" as const,
              };
            })(),
          )
          .mockReturnValueOnce(
            (async function* () {
              yield { type: "text" as const, content: "Done" };
              yield { type: "done" as const, finishReason: "stop" as const };
            })(),
          ),
        countTokens: vi.fn().mockReturnValue(10),
      },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("write a file");

    expect(result.success).toBe(true);
    expect((deps.pluginManager.runOnToolStart as any).mock.calls.length).toBe(1);
    expect((deps.pluginManager.runOnToolEnd as any).mock.calls.length).toBe(1);
    const endCall = (deps.pluginManager.runOnToolEnd as any).mock.calls[0];
    expect(endCall[1]).toMatchObject({ name: "write_file", id: "call_1" });
    expect(endCall[2]).toMatchObject({ success: true, output: "tool ok" });
    expect(typeof endCall[3]).toBe("number");
  });

  it("applies onText and onMeta transforms to streamed output", async () => {
    const deps = createMockDeps({
      pluginManager: {
        ...createMockDeps().pluginManager,
        runOnText: vi
          .fn()
          .mockImplementation((_ctx: unknown, chunk: string) =>
            chunk.replace(/secret/g, "[redacted]"),
          ),
        runOnMeta: vi
          .fn()
          .mockImplementation((_ctx: unknown, chunk: string) =>
            chunk.replace(/secret/g, "[redacted]"),
          ),
      },
      llmProvider: {
        model: "test-model",
        contextWindow: 4096,
        chat: vi.fn().mockReturnValue(
          (async function* () {
            yield { type: "reasoning" as const, content: "secret plan" };
            yield { type: "text" as const, content: "the secret is out" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
        countTokens: vi.fn().mockReturnValue(10),
      },
    });
    const agent = new Agent(deps as any);
    const chunks: string[] = [];
    const meta: string[] = [];
    await agent.run(
      "test",
      (c) => chunks.push(c),
      (m) => meta.push(m),
    );

    expect(chunks.join("")).toContain("[redacted]");
    expect(chunks.join("")).not.toContain("secret");
    expect(meta.join("")).not.toContain("secret");
  });

  it("truncateToolOutput respects absolute max chars limit", () => {
    const longOutput = "x".repeat(20000);
    const budget = { history: 20480 };
    const currentTokens = 5000;

    const result = truncateToolOutput(longOutput, budget, currentTokens, false);
    expect(result.length).toBeLessThanOrEqual(15100);
    expect(result).toContain("Truncated");
  });

  it("truncateToolOutput does not truncate short output", () => {
    const shortOutput = "Hello world";
    const budget = { history: 20480 };
    const currentTokens = 5000;

    const result = truncateToolOutput(shortOutput, budget, currentTokens, false);
    expect(result).toBe(shortOutput);
  });

  it("truncateToolOutput respects remaining budget", () => {
    const longOutput = "x".repeat(10000);
    const budget = { history: 20480 };
    const currentTokens = 19000;

    const result = truncateToolOutput(longOutput, budget, currentTokens, false);
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain("Truncated");
  });

  it("filters tool definitions by toolTags when set", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };

    const deps = createMockDeps({
      toolExecutor: mockExecutor as any,
      toolTags: ["file", "code"],
    });
    const agent = new Agent(deps as any);
    await agent.run("hello");

    expect(mockExecutor.getToolDefinitions).toHaveBeenCalledWith(["file", "code"]);
  });

  it("does not filter tools when toolTags is not set", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
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

  it("does not force a compaction on every single iteration when quality is low", async () => {
    let compactCalls = 0;
    const deps = createMockDeps({
      config: { ...createMockDeps().config, maxToolIterations: 20 },
      llmProvider: {
        model: "test-model",
        contextWindow: 4096,
        chat: vi.fn().mockImplementation(() =>
          (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: { id: "call_1", name: "read_file", arguments: "{}" },
            };
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })(),
        ),
        countTokens: vi.fn().mockReturnValue(10),
      },
      contextManager: {
        addMessage: vi.fn(),
        getMessageCount: vi.fn().mockReturnValue(10),
        needsCompaction: vi.fn().mockReturnValue(false),
        compact: vi.fn(() => {
          compactCalls++;
        }),
        getActiveHistory: vi.fn().mockReturnValue([{ role: "user", content: "hello" }]),
        getEstimatedTokens: vi.fn().mockReturnValue(100),
        getBudget: vi.fn().mockReturnValue({
          systemPrompt: 1024,
          responseReserve: 512,
          history: 2560,
        }),
        updateSystemPrompt: vi.fn(),
        getCompactionCount: vi.fn().mockReturnValue(5),
        getIterationsSinceCompaction: vi.fn().mockReturnValue(0),
        getQuality: vi.fn().mockReturnValue(30),
        noteIteration: vi.fn(),
        setToolTokens: vi.fn(),
      } as any,
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("hello");
    // A cooldown of >= 3 iterations means at most ~7 forced compactions in
    // 20 iterations, NOT one per iteration (which was the death spiral).
    expect(compactCalls).toBeLessThanOrEqual(7);
    expect(result.iterationCount).toBe(20);
  });

  it("returns success:false when the final audit is still failing after retries", async () => {
    const failingAudit = async () => ({
      passed: false,
      missingFiles: ["src/missing.ts"],
      createdFiles: [],
      modifiedFiles: [],
      summary: "Task incomplete: 0/1 steps done, 1 files missing",
      typeCheckError: null,
      massEditWarning: null,
      pendingSteps: ["Create src/missing.ts"],
    });
    const deps = createMockDeps({
      finalAudit: failingAudit,
      llmProvider: {
        model: "test-model",
        contextWindow: 4096,
        chat: vi.fn().mockImplementation(() =>
          (async function* () {
            yield { type: "text" as const, content: "Hello from mock LLM" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
        countTokens: vi.fn().mockReturnValue(10),
      },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("hello");
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("finishes after audit retry limit instead of looping forever", async () => {
    let auditCalls = 0;
    const failingAudit = async () => {
      auditCalls++;
      return {
        passed: false,
        missingFiles: ["src/missing.ts"],
        createdFiles: [],
        modifiedFiles: [],
        summary: "Task incomplete: 0/1 steps done, 1 files missing",
        typeCheckError: null,
        massEditWarning: null,
        pendingSteps: ["Create src/missing.ts"],
      };
    };

    const deps = createMockDeps({
      finalAudit: failingAudit,
      llmProvider: {
        model: "test-model",
        contextWindow: 4096,
        chat: vi.fn().mockImplementation(() =>
          (async function* () {
            yield { type: "text" as const, content: "Hello from mock LLM" };
            yield { type: "done" as const, finishReason: "stop" as const };
          })(),
        ),
        countTokens: vi.fn().mockReturnValue(10),
      },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("hello");

    expect(auditCalls).toBe(3);
    expect(result.success).toBe(false);
    expect(deps.llmProvider.chat).toHaveBeenCalledTimes(3);
  });

  it("compares repetition against the actual latest model text, not a stale accepted answer", async () => {
    const prevTexts: string[] = [];
    let validateCalls = 0;
    const texts = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const deps = createMockDeps({
      finalAudit: async () => ({
        passed: false,
        missingFiles: ["src/missing.ts"],
        createdFiles: [],
        modifiedFiles: [],
        summary: "Task incomplete",
        typeCheckError: null,
        massEditWarning: null,
        pendingSteps: ["Create src/missing.ts"],
      }),
      hallucinationDetector: {
        validate: vi.fn(() => {
          validateCalls++;
          if (validateCalls === 1) return { status: "pass" as const };
          return {
            status: "retry" as const,
            kind: "short" as const,
            reason: "Response too short or empty",
          };
        }),
        getConfidenceCheck: vi.fn(() => ({
          setPreviousResponse: vi.fn((t: string) => prevTexts.push(t)),
        })),
        getConsistencyCheck: vi.fn(() => ({
          trackDecision: vi.fn(),
          trackCreatedFile: vi.fn(),
          trackDeletedFile: vi.fn(),
        })),
      },
      llmProvider: {
        model: "test-model",
        contextWindow: 4096,
        chat: vi.fn().mockImplementation(() => {
          const text = texts.shift();
          return (async function* () {
            if (text) yield { type: "text" as const, content: text };
            yield { type: "done" as const, finishReason: "stop" as const };
          })();
        }),
        countTokens: vi.fn().mockReturnValue(10),
      },
    });
    const agent = new Agent(deps as any);
    await agent.run("hello");
    // iter 3 compared "gamma" against the actual previous output "beta",
    // not the stale accepted answer "alpha" from the first pass.
    expect(prevTexts[2]).toBe("beta");
    expect(prevTexts[3]).toBe("gamma");
  });

  it("does not count an audit-triggered repetitive re-answer against the hallucination budget", async () => {
    let auditCalls = 0;
    const failingAudit = async () => {
      auditCalls++;
      return {
        passed: false,
        missingFiles: ["src/missing.ts"],
        createdFiles: [],
        modifiedFiles: [],
        summary: "Task incomplete",
        typeCheckError: null,
        massEditWarning: null,
        pendingSteps: ["Create src/missing.ts"],
      };
    };
    let validateCalls = 0;
    const texts = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const deps = createMockDeps({
      finalAudit: failingAudit,
      hallucinationDetector: {
        validate: vi.fn(() => {
          validateCalls++;
          if (validateCalls === 1) return { status: "pass" as const };
          return {
            status: "retry" as const,
            kind: "repetition" as const,
            reason: "Response too repetitive (75% overlap)",
          };
        }),
        getConfidenceCheck: vi.fn(() => ({
          setPreviousResponse: vi.fn(),
        })),
        getConsistencyCheck: vi.fn(() => ({
          trackDecision: vi.fn(),
          trackCreatedFile: vi.fn(),
          trackDeletedFile: vi.fn(),
        })),
      },
      llmProvider: {
        model: "test-model",
        contextWindow: 4096,
        chat: vi.fn().mockImplementation(() => {
          const text = texts.shift();
          return (async function* () {
            if (text) yield { type: "text" as const, content: text };
            yield { type: "done" as const, finishReason: "stop" as const };
          })();
        }),
        countTokens: vi.fn().mockReturnValue(10),
      },
    });
    const agent = new Agent(deps as any);
    const result = await agent.run("hello");
    // The model reached the audit-retry cap (3) and reported an audit
    // failure — it was NOT cut off early with a response_blocked error.
    expect(auditCalls).toBe(3);
    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/blocked/i);
  });

  it("records a memory rule when the same tool fails repeatedly (non-consecutively)", async () => {
    // Regression: LSP spawn npx ENOENT failed 8x in one session but NEVER
    // consecutively (read_file/other tools succeeded in between), so the
    // 5-consecutive-failures memory write never fired and the systemic
    // failure was never learned. A per-tool counter must catch it.
    const tmpBase = mkdtempSync(join(tmpdir(), "mma-memrule-"));
    const sessionManagerMock = {
      getActiveMeta: vi.fn().mockReturnValue({ id: "ses_test" }),
      getSessionDirectory: vi.fn().mockReturnValue(tmpBase),
      create: vi.fn(),
      getActive: vi.fn().mockReturnValue("ses_test"),
      appendLog: vi.fn(),
      appendMessage: vi.fn(),
      saveAssistantMessage: vi.fn(),
      getActiveHistory: vi.fn().mockReturnValue([]),
    };

    // Every LLM call returns a tool_call for test_tool; the executor always
    // fails it. 4 calls → the tool has failed 4 times (>= 3) → memory rule.
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockImplementation(() =>
        (async function* () {
          yield {
            type: "tool_call" as const,
            toolCall: { id: "call-1", name: "test_tool", arguments: "{}" },
          };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({
        success: false,
        output: "spawn npx ENOENT",
        toolCallId: "call-1",
      }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
      sessionManager: sessionManagerMock as any,
      baseDir: tmpBase,
      memoryStore: new MemoryStore(join(tmpBase, "memory")),
      config: { ...createMockDeps().config, maxToolIterations: 6 },
    });
    const agent = new Agent(deps as any);
    await agent.run("retry failing tool");

    const errorsMd = join(tmpBase, "memory", "errors.md");
    expect(existsSync(errorsMd)).toBe(true);
    const content = readFileSync(errorsMd, "utf-8");
    expect(content).toContain("test_tool");
    expect(content).toContain("spawn npx ENOENT");
    expect(content).toContain("Repeated");
  });

  it("does not count file_info 'Not found' failures toward the per-tool failure threshold", async () => {
    // Regression (session test scenario 9): file_info returns success:false
    // on "Not found" after a delete_file. This is EXPECTED behavior (verifying
    // the file is gone), not a real error. The agent should not count it
    // toward the 3x memory-write threshold.
    const tmpBase = mkdtempSync(join(tmpdir(), "mma-fileinfo-"));
    const sessionManagerMock = {
      getActiveMeta: vi.fn().mockReturnValue({ id: "ses_test" }),
      getSessionDirectory: vi.fn().mockReturnValue(tmpBase),
      create: vi.fn(),
      getActive: vi.fn().mockReturnValue("ses_test"),
      appendLog: vi.fn(),
      appendMessage: vi.fn(),
      saveAssistantMessage: vi.fn(),
      getActiveHistory: vi.fn().mockReturnValue([]),
    };

    let callCount = 0;
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockImplementation(() => {
        callCount++;
        // First 3 calls: delete_file (success) then file_info (fail: not found)
        // 4th call: final answer
        if (callCount <= 3) {
          const toolName = callCount % 2 === 1 ? "delete_file" : "file_info";
          return (async function* () {
            yield {
              type: "tool_call" as const,
              toolCall: {
                id: `call-${callCount}`,
                name: toolName,
                arguments: '{"path":"src/old.ts"}',
              },
            };
            yield { type: "done" as const, finishReason: "tool_calls" as const };
          })();
        }
        return (async function* () {
          yield { type: "text" as const, content: "Done." };
          yield { type: "done" as const, finishReason: "stop" as const };
        })();
      }),
      countTokens: vi.fn().mockReturnValue(10),
    };

    const mockExecutor = {
      execute: vi.fn().mockImplementation((_call: any) => {
        const name = _call.name || _call;
        if (name === "delete_file") {
          return Promise.resolve({ success: true, output: "Deleted src/old.ts" });
        }
        // file_info on a deleted file returns success:false (expected)
        return Promise.resolve({ success: false, output: "Not found: src/old.ts" });
      }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
      sessionManager: sessionManagerMock as any,
      baseDir: tmpBase,
      memoryStore: new MemoryStore(join(tmpBase, "memory")),
      config: { ...createMockDeps().config, maxToolIterations: 6 },
    });
    const agent = new Agent(deps as any);
    await agent.run("delete old.ts and verify");

    // file_info failures should NOT trigger a memory rule
    const errorsMd = join(tmpBase, "memory", "errors.md");
    if (existsSync(errorsMd)) {
      const content = readFileSync(errorsMd, "utf-8");
      expect(content).not.toContain("file_info");
    }
  });

  it("stops mid-tool on shutdown: no tool-result rendering, no session log write", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockImplementation(() =>
        (async function* () {
          yield {
            type: "tool_call" as const,
            toolCall: { id: "call-1", name: "edit_file", arguments: "{}" },
          };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    // Deferred: the tool stays in-flight (like the slow LSP onAfterTool in
    // the interrupted session) until shutdown is requested.
    let resolveTool!: (r: { success: boolean; output: string; diff?: string }) => void;
    const toolDone = new Promise<{ success: boolean; output: string; diff?: string }>((res) => {
      resolveTool = res;
    });
    let capturedSignal: AbortSignal | undefined;
    let resolveCalled!: () => void;
    const executeCalled = new Promise<void>((res) => {
      resolveCalled = res;
    });
    const mockExecutor = {
      execute: vi.fn((_call: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        resolveCalled();
        return toolDone;
      }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };

    const sessionManagerMock = {
      getActiveMeta: vi.fn().mockReturnValue({ id: "ses_test" }),
      getSessionDirectory: vi.fn().mockReturnValue("/tmp"),
      create: vi.fn(),
      getActive: vi.fn().mockReturnValue("ses_test"),
      appendLog: vi.fn(),
      appendMessage: vi.fn(),
      saveAssistantMessage: vi.fn(),
      getActiveHistory: vi.fn().mockReturnValue([]),
    };

    const addMessage = vi.fn();
    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
      sessionManager: sessionManagerMock as any,
      contextManager: {
        addMessage,
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
      },
    });
    const agent = new Agent(deps as any);

    const toolEvents: string[] = [];
    const runPromise = agent.run("write a file", undefined, undefined, (ev: any) => {
      toolEvents.push(ev.type);
    });

    await executeCalled;

    // Interrupt (Esc) — the abort must reach the in-flight tool call.
    expect(capturedSignal?.aborted).toBe(false);
    agent.shutdown();
    expect(capturedSignal?.aborted).toBe(true);

    // The tool completes AFTER shutdown (observed in the interrupted session:
    // the write already happened, the slow LSP check just took seconds).
    resolveTool({ success: true, output: "Replaced in ...", diff: "..." });

    const result = await runPromise;

    // No "Replaced in ..." tool card rendered after "Session ended".
    expect(toolEvents).toEqual(["start"]);
    // No tool-result entry written to the session files after shutdown
    // (appendMessage here is only the initial user message).
    expect(
      (sessionManagerMock.appendMessage as any).mock.calls.some(
        (c: any[]) => c[0]?.role === "tool",
      ),
    ).toBe(false);
    expect(
      (sessionManagerMock.appendLog as any).mock.calls.some(
        (c: any[]) => c[0]?.type === "tool_result",
      ),
    ).toBe(false);
    // The discarded result must not enter the conversation context, but a
    // synthetic tool message must fill the dangling assistant(tool_calls) so
    // OpenAI-compatible backends don't reject the history with HTTP 400.
    const toolMessages = addMessage.mock.calls
      .filter((c: any[]) => c[0]?.role === "tool")
      .map((c: any[]) => c[0]);
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({
      role: "tool",
      content: "[interrupted]",
      name: "edit_file",
      tool_call_id: "call-1",
      success: false,
    });
    // The real (discarded) output must never leak into the history.
    expect(
      toolMessages.some((m: any) => String(m.content).includes("Replaced in")),
    ).toBe(false);
  });

  it("interrupt between batch tools: synthesized stubs keep assistant(tool_calls) paired", async () => {
    const mockProvider = {
      model: "test-model",
      contextWindow: 4096,
      chat: vi.fn().mockImplementation(() =>
        (async function* () {
          yield {
            type: "tool_call" as const,
            toolCall: { id: "call-1", name: "read_file", arguments: "{}" },
          };
          yield {
            type: "tool_call" as const,
            toolCall: { id: "call-2", name: "write_file", arguments: "{}" },
          };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        })(),
      ),
      countTokens: vi.fn().mockReturnValue(10),
    };

    let resolveSecondTool!: (r: { success: boolean; output: string }) => void;
    const secondToolDone = new Promise<{ success: boolean; output: string }>((res) => {
      resolveSecondTool = res;
    });
    let secondStarted!: () => void;
    const secondToolStarted = new Promise<void>((res) => {
      secondStarted = res;
    });
    const mockExecutor = {
      execute: vi.fn().mockImplementation((call: { id?: string; name?: string }) => {
        if (call.id === "call-1") {
          return Promise.resolve({ success: true, output: "file contents" });
        }
        secondStarted();
        return secondToolDone;
      }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };

    const sessionManagerMock = {
      getActiveMeta: vi.fn().mockReturnValue({ id: "ses_test" }),
      getSessionDirectory: vi.fn().mockReturnValue("/tmp"),
      create: vi.fn(),
      getActive: vi.fn().mockReturnValue("ses_test"),
      appendLog: vi.fn(),
      appendMessage: vi.fn(),
      saveAssistantMessage: vi.fn(),
      getActiveHistory: vi.fn().mockReturnValue([]),
    };

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
      sessionManager: sessionManagerMock as any,
      baseDir: "/tmp",
    });
    const agent = new Agent(deps as any);
    const addMessage = deps.contextManager.addMessage;

    const runPromise = agent.run("do two things");
    await secondToolStarted;
    agent.shutdown();
    resolveSecondTool({ success: true, output: "written" });
    await runPromise;

    const assistantCalls = addMessage.mock.calls.filter(
      (c: any[]) => c[0]?.role === "assistant" && c[0]?.tool_calls,
    );
    expect(assistantCalls).toHaveLength(1);

    const toolMessages = addMessage.mock.calls
      .filter((c: any[]) => c[0]?.role === "tool")
      .map((c: any[]) => c[0]);
    // call-1 keeps its real result; call-2 gets a synthesized stub.
    expect(toolMessages.map((m: any) => m.tool_call_id)).toEqual(["call-1", "call-2"]);
    expect(toolMessages[0].content).toBe("file contents");
    expect(toolMessages[1].content).toBe("[interrupted]");
    expect(
      toolMessages.some((m: any) => String(m.content).includes("written")),
    ).toBe(false);
  });
});
