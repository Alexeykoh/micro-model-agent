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
    state.totalBatches = 3;
    state.duplicateBatches = 1;
    state.novelToolKeys.add("read_file::a.ts");

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
      expect.objectContaining({
        provider: "live",
        model: "qwen/qwen3.5-9b",
        progress: { totalBatches: 3, novelTools: 1, duplicateBatches: 1 },
      }),
    );
    expect(record).toHaveBeenCalledWith(100, 20, "live", undefined);
  });

  it("uses provider-reported cost instead of token estimate", () => {
    const record = vi.fn();
    const recordActual = vi.fn();
    const logLlmUsage = vi.fn();
    const tracker = new TokenTracker({ record, recordActual } as never, () => ({
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
    }));
    const state = createLoopState();
    const baseline = tracker.beginIteration(state, 2000);
    tracker.recordApiUsage(state, baseline, {
      promptTokens: 2298,
      completionTokens: 6,
      cache: { cachedTokens: 1664, cacheWriteTokens: 0, uncachedTokens: 634, source: "api" },
      costUsd: 0.00001414,
    });

    tracker.logUsage(state, baseline, "ok", 2000, 1, 10, { logLlmUsage } as never);

    expect(recordActual).toHaveBeenCalledWith(0.00001414, "opencode-go", state.cacheUsage);
    expect(record).not.toHaveBeenCalled();
  });
});
