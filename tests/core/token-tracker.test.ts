import { describe, it, expect, vi } from "vitest";
import { TokenTracker } from "../../src/core/agent/token-tracker";
import { createLoopState } from "../../src/core/agent/loop-state";

describe("TokenTracker.logUsage provenance", () => {
  it("writes the live provider/model into llm_usage and cost attribution", () => {
    // Регрессия: logUsage не передавал provider/model в llm_usage, поэтому
    // session.jsonl терял провенанс (и после failover оставался неверным).
    const record = vi.fn();
    const logLlmUsage = vi.fn();
    const tracker = new TokenTracker({ record } as never, () => ({
      provider: "live",
      model: "qwen/qwen3.5-9b",
    }));
    const state = createLoopState();
    state.apiPromptTokens = 100;
    state.apiCompletionTokens = 20;

    tracker.logUsage(
      state,
      { promptBefore: 0, completionBefore: 0 },
      "some text",
      50,
      1,
      10,
      { logLlmUsage } as never,
    );

    expect(logLlmUsage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ provider: "live", model: "qwen/qwen3.5-9b" }),
    );
    expect(record).toHaveBeenCalledWith(100, 20, "live", undefined);
  });
});
