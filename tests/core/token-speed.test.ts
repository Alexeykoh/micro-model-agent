/**
 * Скорость генерации: decode меряется от первого контентного чанка (без
 * префилла), а не от старта вызова; per-call записи копятся в LoopState.
 */
import { describe, expect, it } from "vitest";
import { runLlmPhase, type LlmPhaseHost } from "../../src/core/agent/loop-llm";
import { createLoopState } from "../../src/core/agent/loop-state";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeHost(delayMs: number) {
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
    logger: {
      logLLMRequest: () => {},
      logLLMResponse: () => {},
      diagnostic: () => {},
    },
    llmProvider: {
      chat: async function* () {
        await sleep(delayMs);
        yield { type: "text" as const, content: "hello world" };
        await sleep(delayMs);
        yield { type: "done" as const, finishReason: "stop" as const };
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

describe("LLM decode speed", () => {
  it("excludes time-to-first-token from decodeMs", async () => {
    const calls: Array<{ durationMs: number; decodeMs: number }> = [];
    const host = makeHost(35);
    const outcome = await runLlmPhase(host, {
      state: createLoopState(),
      slog: { logReasoningControl: () => {}, logError: () => {} } as never,
      input: "hi",
      history: [],
      allToolsForBudget: [],
      tokenTracker: {
        beginIteration: () => ({ promptBefore: 0, completionBefore: 0 }),
        recordApiUsage: () => {},
        addCompletionChars: () => {},
        finishCall: (
          _state: unknown,
          _baseline: unknown,
          _text: unknown,
          _ctx: unknown,
          _iter: unknown,
          startedAt: number,
          firstTokenAt: number,
        ) => {
          const end = Date.now();
          calls.push({ durationMs: end - startedAt, decodeMs: end - firstTokenAt });
          return end - startedAt;
        },
        logUsage: () => {},
      } as never,
      reasoningResolver: { resolve: () => ({ level: undefined }) } as never,
    });

    expect(outcome.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    // Первый чанк приходит через ~35 мс, второй — ещё через ~35 мс.
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(60);
    expect(calls[0].decodeMs).toBeGreaterThan(10);
    expect(calls[0].decodeMs).toBeLessThan(calls[0].durationMs);
  });
});
