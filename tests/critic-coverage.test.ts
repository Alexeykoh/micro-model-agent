import { describe, it, expect, vi } from "vitest";
import { Agent } from "../src/core/agent";
import type { AgentDeps } from "../src/core/agent";
import { CriticGate } from "../src/core/agent/critic-gate";
import { createLoopState } from "../src/core/agent/loop-state";
import type { EvidencePack } from "../src/modules/critic/types";

/**
 * Покрытие критика (W5, INV-C6/INV-C7).
 *
 * Было: критик проверял только ходы с тулами; чат-доставка и форс-финал по
 * исчерпанию итераций (самый длинный и самый рискованный ход) проходили мимо
 * проверки. А «совет» (`concern`) инжектился в уже завершающийся ход — модель
 * его не видела, и вердикт оставался без последствий.
 */

/** Мок зависимостей агента: провайдер отдаёт заскриптованные ответы. */
function createMockDeps(replies: Array<() => AsyncGenerator<any>>) {
  const messages: any[] = [];
  let call = 0;
  const provider = {
    model: "test-model",
    contextWindow: 4096,
    countTokens: vi.fn().mockReturnValue(10),
    listModels: async () => [],
    chat: vi.fn().mockImplementation(() => {
      const reply = replies[Math.min(call, replies.length - 1)];
      call++;
      return reply();
    }),
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
  } as unknown as AgentDeps;
  return { deps, provider, messages };
}

/** Ответ модели текстом. */
function textReply(content: string) {
  return async function* () {
    yield { type: "text" as const, content };
    yield { type: "done" as const, finishReason: "stop" as const };
  };
}

/** Ответ модели вызовом тула. */
function toolReply(name = "read_file", args: Record<string, unknown> = { path: "a.ts" }) {
  return async function* () {
    yield {
      type: "tool_call" as const,
      toolCall: { id: "t1", name, arguments: JSON.stringify(args) },
    };
    yield { type: "done" as const, finishReason: "tool_calls" as const };
  };
}

describe("critic coverage (W5)", () => {
  it("checks a chat-only answer (no tool calls at all)", async () => {
    const packs: EvidencePack[] = [];
    const verify = vi.fn(async (pack: EvidencePack) => {
      packs.push(pack);
      return { status: "ok" as const, summary: "fine", issues: [] };
    });
    const t = createMockDeps([textReply("Ответ без единого тула")]);
    const agent = new Agent({ ...t.deps, criticOverride: { verify } } as AgentDeps);
    await agent.run("просто ответь");

    // Раньше чат-доставка вообще не доходила до критика.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(packs[0].answerExcerpt).toContain("Ответ без единого тула");
  });

  it("checks the forced final answer when the iteration budget is exhausted", async () => {
    const packs: EvidencePack[] = [];
    const verify = vi.fn(async (pack: EvidencePack) => {
      packs.push(pack);
      return { status: "ok" as const, summary: "fine", issues: [] };
    });
    const t = createMockDeps([toolReply(), textReply("финальный ответ по форс-финалу")]);
    const deps = {
      ...t.deps,
      config: { ...(t.deps as any).config, maxToolIterations: 1 },
      criticOverride: { verify },
    } as unknown as AgentDeps;
    const agent = new Agent(deps);
    await agent.run("сделай работу тулами");

    // Форс-финал (самый длинный ход) раньше проходил мимо проверки.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(packs[0].answerExcerpt).toContain("финальный ответ по форс-финалу");
  });
});

describe("critic advice reaches the model (W5, INV-C6)", () => {
  function gateDeps() {
    const state = createLoopState();
    const messages: any[] = [];
    return {
      state,
      messages,
      deps: {
        state,
        iteration: 3,
        logger: { warn: vi.fn(), info: vi.fn(), diagnostic: vi.fn() } as never,
        contextManager: { addMessage: (m: any) => messages.push(m) } as never,
        slog: { logCritic: vi.fn(), logDiagnosticEvent: vi.fn() } as never,
        task: "do it",
        beforeFinish: true,
        toolEvents: [{ tool: "bash", args: { command: "ls" }, ok: true }],
      },
    };
  }

  it("a concern verdict asks the model to answer again (not a dead injection)", async () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => ({
        status: "concern" as const,
        summary: "gap",
        issues: [{ severity: "concern" as const, claim: "c", problem: "p" }],
      }),
      buildPack: (x: never) => x,
    });
    expect(await gate.evaluate(d.deps)).toBe("retry");
    expect(d.messages.length).toBe(1);
    expect(String(d.messages[0].content)).toContain("system-summary");
  });

  it("the advice budget is bounded (one advisory round per turn)", async () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => ({
        status: "concern" as const,
        summary: "gap",
        issues: [{ severity: "concern" as const, claim: "c", problem: "p" }],
      }),
      buildPack: (x: never) => x,
    });
    expect(await gate.evaluate(d.deps)).toBe("retry");
    // Второй круг: та же жалоба уже видна → повтор, но бюджет советов исчерпан.
    expect(await gate.evaluate(d.deps)).toBe("pass");
  });

  it("a repeated complaint tells the model to change the approach", async () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => ({
        status: "critical" as const,
        summary: "broken",
        issues: [{ severity: "critical" as const, claim: "c", problem: "p" }],
      }),
      buildPack: (x: never) => x,
    });
    // Первая проверка: critical → ремонт (бюджет ремонта тратится).
    expect(await gate.evaluate(d.deps)).toBe("retry");
    d.messages.length = 0;
    // Вторая: та же жалоба → повтор. Совет ещё не потрачен → модель получает
    // «смени подход», а не молчаливый pass.
    expect(await gate.evaluate(d.deps)).toBe("retry");
    expect(d.messages.length).toBe(1);
    expect(String(d.messages[0].content)).toContain("system-summary");
  });

  it("no dead injection when the advice budget is spent", async () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => ({
        status: "concern" as const,
        summary: "gap",
        issues: [{ severity: "concern" as const, claim: "c", problem: "p" }],
      }),
      buildPack: (x: never) => x,
    });
    await gate.evaluate(d.deps);
    d.messages.length = 0;
    // Другая жалоба, но совет уже потрачен → pass без мёртвой инъекции.
    expect(await gate.evaluate(d.deps)).toBe("pass");
    expect(d.messages.length).toBe(0);
  });
});
