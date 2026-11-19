/**
 * Серия молчания — индикатор тишины ТЕКУЩЕГО хода.
 *
 * Разбор ses_mwc2p7hh_… (2026-11-11): чекпоинт хода переживал границу хода,
 * поэтому стрик молчания прошлого хода восстанавливался в следующем. Новый
 * запрос пользователя умирал на первом же молчаливом пакете — «Инструменты
 * отключены» при живых тулах (три форс-финала подряд).
 *
 * Тест держит две вещи:
 * 1) видимый пользователю текст прерывает серию (в том числе ответ без
 *    вызовов тулов);
 * 2) серия не переживает границу хода: чекпоинт незавершённого хода удаляется
 *    на её исходе, поэтому следующий ход начинается с нуля.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Agent } from "../../src/core/agent";
import { runLlmPhase, type LlmPhaseHost } from "../../src/core/agent/loop-llm";
import { createLoopState } from "../../src/core/agent/loop-state";
import { SessionManager } from "../../src/modules/session/manager";
import { SessionStore } from "../../src/modules/session/store";
import { HARD_STOP_SILENT_BATCHES } from "../../src/core/agent/constants";

/** Хост фазы LLM: провайдер отвечает видимым текстом, без вызовов тулов. */
function makeTextHost(text: string) {
  const deps = {
    contextManager: {
      getEstimatedTokens: () => 0,
      getMessageCount: () => 0,
      addMessage: () => {},
      calibrate: () => {},
      thinkingLevel: "",
    },
    pluginManager: {
      runOnText: (_ctx: unknown, chunk: string) => chunk,
      runOnMeta: () => undefined,
      runOnAfterThink: () => {},
    },
    logger: { logLLMRequest: () => {}, logLLMResponse: () => {}, diagnostic: () => {} },
    llmProvider: {
      chat: async function* () {
        yield { type: "text" as const, content: text };
        yield { type: "done" as const };
      },
    },
    config: { model: "m", showReasoning: false, reasoning: {} },
    sessionManager: { getActiveMeta: () => undefined },
  };
  const host: LlmPhaseHost = {
    deps: deps as never,
    policyState: {} as never,
    probePassed: true,
    reasoningState: {} as never,
    isShutdownRequested: () => false,
    getAbortSignal: () => undefined,
    emitPhase: () => {},
  };
  return host;
}

describe("серия молчания прерывается видимым текстом", () => {
  it("обнуляет счётчик, когда модель заговорила без вызовов тулов", async () => {
    const host = makeTextHost("читаю конфиг контейнера");
    const state = createLoopState();
    state.consecutiveSilentBatches = 5;
    state.narrationNudged = true;

    const outcome = await runLlmPhase(host, {
      state,
      slog: { logReasoningControl: () => {}, logError: () => {} } as never,
      input: "check",
      history: [],
      allToolsForBudget: [],
      tokenTracker: {
        beginIteration: () => ({}),
        recordApiUsage: () => {},
        addCompletionChars: () => {},
        finishCall: () => 0,
        logUsage: () => {},
      } as never,
      reasoningResolver: { resolve: () => ({ level: undefined }) } as never,
    });

    expect(outcome.kind).toBe("ok");
    expect(state.consecutiveSilentBatches).toBe(0);
    expect(state.narrationNudged).toBe(false);
  });
});

/** Заглушки зависимостей агента (по образцу `agent-turn-end.test.ts`). */
function createMockDeps(sessionManager: SessionManager, chat: () => AsyncGenerator<any>) {
  const mockProvider = {
    model: "test-model",
    contextWindow: 4096,
    chat: vi.fn().mockImplementation(chat),
    countTokens: vi.fn().mockReturnValue(10),
  };
  const mockToolExecutor = {
    execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
    fork: vi.fn().mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
    })),
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
    runOnText: vi.fn().mockImplementation((_c: unknown, chunk: string) => chunk),
    runOnMeta: vi.fn().mockImplementation((_c: unknown, chunk: string) => chunk),
    runOnError: vi.fn(),
    runOnSessionStart: vi.fn(),
    runOnSessionEnd: vi.fn(),
    runOnTurnEnd: vi.fn(),
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
        maxToolIterations: 40,
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
      sessionManager,
    } as any,
    provider: mockProvider,
  };
}

describe("серия молчания не переживает границу хода", () => {
  it("новый запрос пользователя не умирает на первом молчаливом пакете", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-silence-"));
    const store = new SessionStore(dir);
    const sessionManager = new SessionManager(store, {
      model: "test-model",
      contextWindow: 4096,
      projectDir: dir,
    });
    sessionManager.create();

    // Ход 1: 13 молчаливых пакетов (до порога жёсткого стопа) и видимый ответ.
    // Ход 2: один молчаливый пакет — с утечкой он закрыл бы ход стопом «silent».
    const silentCalls = new Set([
      ...Array.from({ length: HARD_STOP_SILENT_BATCHES - 1 }, (_, i) => i),
      14,
    ]);
    let call = 0;
    const t = createMockDeps(sessionManager, () =>
      (async function* () {
        const n = call++;
        if (silentCalls.has(n)) {
          yield {
            type: "tool_call" as const,
            toolCall: {
              id: `t${n}`,
              name: "bash",
              arguments: JSON.stringify({ command: `echo ${n}` }),
            },
          };
          yield { type: "done" as const, finishReason: "tool_calls" as const };
        } else {
          yield { type: "text" as const, content: "готово" };
          yield { type: "done" as const, finishReason: "stop" as const };
        }
      })(),
    );
    const agent = new Agent(t.deps);

    const first = await agent.run("сделай 13 шагов молча");
    expect(first.stopReason).toBeUndefined();
    // Чекпоинт незавершённого хода на границе хода удалён: состояние прошлого
    // хода не должно пережить его границу.
    const sessionId = sessionManager.getActiveMeta()!.id;
    expect(store.loadCheckpoint(sessionId)).toBeNull();

    const second = await agent.run("ещё один шаг");
    expect(second.stopReason).not.toBe("silent");
    expect(second.text).toBe("готово");
  });
});
