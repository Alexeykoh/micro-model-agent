/**
 * Пауза/возобновление хода на границе итераций (спека
 * docs/specs/2026-11-06-webui-pause-resume-design.md, INV-P1…P4).
 *
 * Контракт: `pause()` удерживает цикл перед следующим вызовом модели,
 * `resume()` продолжает ТОТ ЖЕ ход (без нового сообщения), shutdown будит
 * гейт (нет зависания), флаг паузы не течёт за границу хода.
 */
import { describe, it, expect, vi } from "vitest";
import { Agent, type AgentDeps } from "../../src/core/agent";
import { DEFAULTS } from "../../src/config/defaults";

const config = { ...DEFAULTS, maxToolIterations: 5, autoPlan: false };

/**
 * Провайдер из двух сцен: 1-й вызов — tool_call (ход продолжает итерацию),
 * 2-й — финальный текст. `beforeFirstYield` выполняется в начале первого
 * ответа (уже агент, уже на паузе — гейт увидит флаг на границе итерации 2).
 */
function scriptedAgent(beforeFirstYield?: () => void, finalText = "FINAL", directAnswer = false) {
  let chatCalls = 0;
  const provider = {
    model: "test-model",
    contextWindow: 4096,
    countTokens: vi.fn().mockReturnValue(10),
    chat: vi.fn(async function* () {
      chatCalls++;
      if (chatCalls === 1) beforeFirstYield?.();
      if (!directAnswer && chatCalls === 1) {
        yield {
          type: "tool_call" as const,
          toolCall: {
            id: "t1",
            name: "write_file",
            arguments: JSON.stringify({ path: "a.txt", content: "x" }),
          },
        };
        yield { type: "done" as const, finishReason: "tool_calls" as const };
        return;
      }
      yield { type: "text" as const, content: finalText };
      yield { type: "done" as const, finishReason: "stop" as const };
    }),
  };
  const deps = {
    config,
    llmProvider: provider,
    toolExecutor: {
      execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
      updateProvider: vi.fn(),
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
      runOnText: vi.fn().mockImplementation((_ctx: unknown, chunk: string) => chunk),
      runOnMeta: vi.fn().mockImplementation((_ctx: unknown, chunk: string) => chunk),
      runOnError: vi.fn(),
      runOnSessionStart: vi.fn(),
      runOnSessionEnd: vi.fn(),
      runOnTurnEnd: vi.fn(),
      setHostBridge: vi.fn(),
    },
    contextManager: {
      addMessage: vi.fn(),
      setHarnessSink: vi.fn(),
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
      resize: vi.fn(),
      setStandingDirective: vi.fn(),
      clearStandingDirective: vi.fn(),
      resetUserTurn: vi.fn(),
      addPendingImage: vi.fn(),
      getPendingImages: vi.fn().mockReturnValue([]),
      standingDirectives: { clear: vi.fn() },
    },
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
      logDirective: vi.fn(),
      initSessionLog: vi.fn(),
      closeSessionLog: vi.fn(),
      setSessionDir: vi.fn(),
      forSession: vi.fn(),
    },
    baseDir: "/tmp",
    promptBlocks: [],
  } as unknown as AgentDeps;
  return { agent: new Agent(deps), provider, callCount: () => chatCalls };
}

/** Опрос условия с дедлайном. */
async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Не «done», если промис не оседает за `ms`. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([
    p,
    new Promise<"pending">((r) => {
      setTimeout(() => r("pending"), ms);
    }),
  ]);
}

describe("agent pause at iteration boundary (INV-P1…P4)", () => {
  it("pause holds the loop before the next LLM call; resume continues the SAME turn", async () => {
    const ref: { agent?: Agent } = {};
    const { agent, provider, callCount } = scriptedAgent(() => ref.agent?.pause());
    ref.agent = agent;

    const runP = agent.run("go");
    await until(() => agent.isPaused());
    // Гейт закрыл вход во вторую итерацию: модель не звалась снова.
    await new Promise((r) => setTimeout(r, 120));
    expect(callCount()).toBe(1);
    expect(await settleWithin(runP, 120)).toBe("pending");

    agent.resume();
    const result = await runP;
    expect(callCount()).toBe(2);
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("FINAL");
    expect(agent.isPaused()).toBe(false);
  });

  it("shutdown wakes a paused turn instead of hanging (INV-P3)", async () => {
    const ref: { agent?: Agent } = {};
    const { agent, callCount } = scriptedAgent(() => ref.agent?.pause());
    ref.agent = agent;

    const runP = agent.run("go");
    await until(() => agent.isPaused());
    expect(callCount()).toBe(1);

    agent.shutdown();
    const outcome = await settleWithin(runP, 1500);
    expect(outcome).not.toBe("pending"); // распалось — зависанию нет
    expect(agent.isPaused()).toBe(false);
  });

  it("a pause left over from a finished turn does not block the next one (INV-P4)", async () => {
    const ref: { agent?: Agent } = {};
    // directAnswer: единственный вызов — финальный текст. Пауза ставится в
    // его моменте, но гейт на этой итерации уже пройден — ход штатно
    // завершается с «висящим» флагом. Следующий run обязан его сбросить.
    const { agent } = scriptedAgent(() => ref.agent?.pause(), "ONE", true);
    ref.agent = agent;
    const first = await agent.run("go");
    expect(first.text).toBe("ONE");
    expect(agent.isPaused()).toBe(true); // флаг остался после хода

    const again = await agent.run("again");
    expect(again.text).toBe("ONE");
    expect(agent.isPaused()).toBe(false);
  });
});
