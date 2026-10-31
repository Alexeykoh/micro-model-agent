/**
 * Обрыв генерации ДО первого символа ответа: бюджет съели рассуждения
 * (спека `2026-10-27-subagent-reliability-design` §B.2).
 *
 * До правки петля повторяла тот же запрос, а reasoning-политика на
 * `recoverableLlmError` поднимала уровень до "high" — повтор обрывался снова.
 * Здесь проверяется, что повтор идёт с выключенным reasoning и удвоенным
 * бюджетом и что третьей попытки нет.
 */
import { describe, expect, it } from "vitest";
import { runLlmPhase, type LlmPhaseHost } from "../../src/core/agent/loop-llm";
import { createLoopState } from "../../src/core/agent/loop-state";
import { ReasoningEffortResolver } from "../../src/core/agent/reasoning-resolver";
import { createPolicyState } from "../../src/modules/reasoning/policy";
import { LlmError } from "../../src/llm/llm-errors";
import { t } from "../../src/i18n/index";
import type { ChatOptions } from "../../src/llm/provider";

/** Сколько раз модель можно усечь до ответа (0 = сразу отвечает). */
function makeHost(truncations: number) {
  const calls: ChatOptions[] = [];
  const added: string[] = [];
  const levels: (string | undefined)[] = [];
  const cleared: string[] = [];
  let n = 0;

  const deps = {
    contextManager: {
      getEstimatedTokens: () => 0,
      getMessageCount: () => 0,
      addMessage: (m: { content: string }) => added.push(m.content),
      setStandingDirective: () => {},
      clearStandingDirective: (id: string) => cleared.push(id),
      calibrate: () => {},
      thinkingLevel: "",
    },
    pluginManager: {
      runOnText: (_ctx: unknown, chunk: string) => chunk,
      runOnMeta: () => undefined,
      runOnAfterThink: () => {},
      runOnError: () => {},
    },
    logger: {
      logLLMRequest: () => {},
      logLLMResponse: () => {},
      diagnostic: () => {},
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: () => {},
    },
    llmProvider: {
      chat: (
        _messages: unknown[],
        _tools: unknown,
        _signal: unknown,
        options?: ChatOptions,
      ) => {
        calls.push(options ?? {});
        n++;
        const fail = n <= truncations;
        return (async function* () {
          if (fail) {
            throw new LlmError(t("error.llm_truncated_reasoning", { tokens: "900" }), {
              terminal: true,
              recoverable: true,
              kind: "truncated_no_content",
              limit: 900,
            });
          }
          yield { type: "text" as const, content: "готово" };
          yield { type: "done" as const };
        })();
      },
    },
    config: {
      model: "m",
      showReasoning: false,
      reasoning: { mode: "auto", min: "low", baseline: "low", max: "high" },
    },
    sessionManager: { getActiveMeta: () => undefined },
  };

  const host: LlmPhaseHost = {
    deps: deps as never,
    policyState: createPolicyState(),
    probePassed: true,
    reasoningState: { manual: false, level: "low", overrideIteration: -1 } as never,
    isShutdownRequested: () => false,
    getAbortSignal: () => undefined,
    emitPhase: (_i, _p, _cb, info) => {
      if (info?.level) levels.push(info.level);
    },
  };
  return { host, calls, added, levels, cleared };
}

const resolver = new ReasoningEffortResolver();

function phaseArgs(host: LlmPhaseHost) {
  return {
    slog: { logReasoningControl: () => {}, logError: () => {} } as never,
    input: "прочитай файл",
    history: [],
    allToolsForBudget: [],
    tokenTracker: {
      beginIteration: () => ({}),
      recordApiUsage: () => {},
      addCompletionChars: () => {},
      finishCall: () => 0,
      logUsage: () => {},
    } as never,
    reasoningResolver: resolver,
  };
}

describe("truncation before any output", () => {
  it("retries once with reasoning off and a doubled budget", async () => {
    const { host, calls, added, levels, cleared } = makeHost(1);
    const state = createLoopState();
    state.iteration = 1;
    const args = phaseArgs(host);

    const first = await runLlmPhase(host, { ...args, state });
    expect(first.kind).toBe("continue");
    expect(state.truncationRetries).toBe(1);
    expect(state.iterForceNoReasoning).toBe(true);
    expect(state.iterMaxTokensOverride).toBe(1800);
    expect(added.join("\n")).toContain(
      t("exec.truncated_no_content", { tokens: "900" }),
    );

    state.iteration = 2;
    const second = await runLlmPhase(host, { ...args, state });
    expect(second.kind).toBe("ok");
    expect(calls).toHaveLength(2);
    // Повтор: reasoning выключен, бюджет удвоен, политика не подняла до high.
    expect(calls[1].reasoningEffort).toBe("none");
    expect(calls[1].maxTokens).toBe(1800);
    expect(levels).toEqual(["low", "none"]);
    // Директива снята: условие «ответь сразу» больше не выполняется.
    expect(cleared).toContain("truncated");
    // Счётчик повторов сброшен — следующий обрыв снова получит одну попытку.
    expect(state.truncationRetries).toBe(0);
  });

  it("gives up after one retry with the honest cause", async () => {
    const { host, calls } = makeHost(2);
    const state = createLoopState();
    state.iteration = 1;
    const args = phaseArgs(host);

    const first = await runLlmPhase(host, { ...args, state });
    expect(first.kind).toBe("continue");

    state.iteration = 2;
    const second = await runLlmPhase(host, { ...args, state });
    expect(second.kind).toBe("return");
    expect(second.kind === "return" && second.result.success).toBe(false);
    expect(calls).toHaveLength(2);
    // Общий обработчик recoverable-ошибок в этом сценарии не участвовал:
    // второй заход оборвался уже за пределами лимита повторов.
    expect(state.truncationRetries).toBe(1);
    expect(state.llmErrorRetries).toBe(0);
  });
});
