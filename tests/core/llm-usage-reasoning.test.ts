/**
 * Скорость генерации должна учитывать reasoning: оценка completion-токенов
 * без API-usage (LM Studio/llama.cpp) суммирует text + reasoning, иначе
 * длительный thinking занижает т/с (раньше было text || reasoning).
 */
import { describe, expect, it } from "vitest";
import { finalizeLlmUsage } from "../../src/core/agent/loop-llm-usage";
import { createLoopState } from "../../src/core/agent/loop-state";
import { createLlmStreamResult } from "../../src/core/agent/loop-llm-stream";
import { TokenTracker } from "../../src/core/agent/token-tracker";

function setup() {
  const state = createLoopState();
  const tracker = new TokenTracker({ record: () => {} } as never, () => ({
    provider: "test",
    model: "m",
  }));
  const logs: Array<{ chars: number }> = [];
  const inp = {
    state,
    slog: { logLlmUsage: () => {} } as never,
    tokenTracker: tracker,
    contextManager: { getEstimatedTokens: () => 100 } as never,
    logger: {
      logLLMResponse: (_m: string, chars: number) => logs.push({ chars }),
    } as never,
    model: "m",
    baseline: { promptBefore: 0, completionBefore: 0 },
  };
  return { state, inp, logs };
}

describe("llm usage includes reasoning in completion estimate", () => {
  it("sums text and reasoning chars when provider omits usage", () => {
    const { state, inp, logs } = setup();
    const stream = createLlmStreamResult();
    stream.textContent = "hi"; // 2 chars
    stream.reasoningContent = "x".repeat(198); // 198 chars
    stream.firstTokenAt = Date.now() - 1000;
    const started = Date.now() - 2000;
    finalizeLlmUsage({ ...inp, stream, llmStart: started } as never);
    // 200 chars / 4 = 50 tokens estimate, decode ~1000ms.
    expect(state.llmSpeedCalls).toHaveLength(1);
    expect(state.llmSpeedCalls[0].completionTokens).toBe(50);
    expect(logs[0].chars).toBe(200);
  });

  it("still counts reasoning-only responses", () => {
    const { state, inp } = setup();
    const stream = createLlmStreamResult();
    stream.textContent = "";
    stream.reasoningContent = "y".repeat(40);
    stream.firstTokenAt = Date.now() - 500;
    finalizeLlmUsage({ ...inp, stream, llmStart: Date.now() - 1000 } as never);
    expect(state.llmSpeedCalls[0].completionTokens).toBe(10);
  });
});
