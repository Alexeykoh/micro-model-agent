/**
 * Достижимость провайдера: ответ модели снимает «недоступен».
 *
 * Разбор ses_mwdlv8tg_… (2026-11-12): discovery-проба 3 с упала на VPN-лаге,
 * записала `reachable=false`, и сайдбар показывал `provider_unavailable` всё
 * время, пока провайдер исправно отвечал. Залипание лечится на источнике:
 * успешный LLM-вызов — прямое доказательство достижимости.
 */
import { describe, expect, it } from "vitest";
import { runLlmPhase, type LlmPhaseHost } from "../../src/core/agent/loop-llm";
import { createLoopState } from "../../src/core/agent/loop-state";

function makeHost(probeRef: { reachable?: boolean }, chat: () => AsyncGenerator<unknown>) {
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
    llmProvider: { chat },
    config: { model: "m", showReasoning: false, reasoning: {} },
    sessionManager: { getActiveMeta: () => undefined },
    capabilitiesProbeRef: probeRef,
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

function phaseInput() {
  return {
    state: createLoopState(),
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
  };
}

describe("provider reachability from a successful answer", () => {
  it("clears a latched `false` when the model answers", async () => {
    const probeRef = { reachable: false };
    const host = makeHost(probeRef, async function* () {
      yield { type: "text" as const, content: "ok" };
      yield { type: "done" as const };
    });

    const outcome = await runLlmPhase(host, phaseInput());

    expect(outcome.kind).toBe("ok");
    expect(probeRef.reachable).toBe(true);
  });

  it("leaves the verdict untouched when the call throws", async () => {
    const probeRef = { reachable: false };
    const host = makeHost(probeRef, async function* () {
      throw new Error("ECONNREFUSED");
      // unreachable
      yield { type: "done" as const };
    });

    await runLlmPhase(host, phaseInput()).catch(() => undefined);

    expect(probeRef.reachable).toBe(false);
  });
});
