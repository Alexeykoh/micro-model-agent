/**
 * W1.1: жёсткий стоп по повторяющемуся status-тулу обязан быть честным —
 * `stopReason="duplicate"` и форс-финальный ответ, а не «успех с пустым
 * текстом» (§1.1 аудита harness-модулей).
 */
import { describe, expect, it } from "vitest";
import { runLlmPhase, type LlmPhaseHost } from "../../src/core/agent/loop-llm";
import { createLoopState } from "../../src/core/agent/loop-state";
import { canonicalArgsKey } from "../../src/core/agent/canonical-args";

function toolCallChunk(name: string, args: Record<string, unknown>) {
  return {
    type: "tool_call" as const,
    toolCall: { id: "t1", name, arguments: JSON.stringify(args) },
  };
}

/** Хост фазы LLM: провайдер всегда отвечает одним и тем же status-тулом. */
function makeHost(toolName = "session_info") {
  const added: string[] = [];
  const deps = {
    contextManager: {
      getEstimatedTokens: () => 0,
      getMessageCount: () => 0,
      addMessage: (m: { content: string }) => added.push(m.content),
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
        yield toolCallChunk(toolName, {});
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
  return { host, added };
}

describe("repeated status-tool hard stop", () => {
  it("marks the turn as duplicate instead of an empty success", async () => {
    const { host } = makeHost();
    const state = createLoopState();
    state.iteration = 1;
    // Подпись предыдущего вызова совпадает ⇒ повтор засчитан (каноническая).
    state.lastToolSignature = canonicalArgsKey("session_info", {});
    state.repeatedToolCount = 4;

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
        logUsage: () => {},
      } as never,
      reasoningResolver: { resolve: () => ({ level: undefined }) } as never,
    });

    expect(outcome.kind).toBe("break");
    expect(state.finalizeReason).toBe("duplicate");
    expect(state.stopReason).toBe("duplicate");
  });

  it("does not stop on a mutating tool with the same arguments", async () => {
    const { host } = makeHost("write_file");
    const state = createLoopState();
    state.iteration = 1;
    state.lastToolSignature = canonicalArgsKey("write_file", {});
    state.repeatedToolCount = 4;

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
        logUsage: () => {},
      } as never,
      reasoningResolver: { resolve: () => ({ level: undefined }) } as never,
    });

    expect(outcome.kind).toBe("ok");
    expect(state.finalizeReason).toBeNull();
  });
});
