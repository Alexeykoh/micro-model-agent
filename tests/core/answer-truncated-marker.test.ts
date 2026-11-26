import { describe, expect, it } from "vitest";
import { markTruncatedAnswer } from "../../src/core/agent/truncated-answer";
import { createLoopState } from "../../src/core/agent/loop-state";
import { buildLoopResult } from "../../src/core/agent/loop-result";
import type { LoopResultHost } from "../../src/core/agent/loop-result";
import type { TokenTracker } from "../../src/core/agent/token-tracker";

describe("truncated final answer marker", () => {
  it("marks a non-empty answer when the provider hit the token limit", () => {
    const marked = markTruncatedAnswer("Часть ответа без точки", "length", true);
    expect(marked).toContain("TRUNCATED");
    expect(marked).toContain("Часть ответа без точки");
  });

  it("leaves normal answers untouched", () => {
    expect(markTruncatedAnswer("Готовый ответ.", "stop", true)).toBe("Готовый ответ.");
    expect(markTruncatedAnswer("Готовый ответ.", undefined, true)).toBe("Готовый ответ.");
    expect(markTruncatedAnswer("Готовый ответ.", "length", false)).toBe("Готовый ответ.");
  });

  it("does not mark empty text and is idempotent", () => {
    expect(markTruncatedAnswer("", "length", true)).toBe("");
    const once = markTruncatedAnswer("x", "length", true);
    expect(markTruncatedAnswer(once, "length", true)).toBe(once);
  });

  it("marks the text of a failed audit with a non-empty answer", () => {
    const state = createLoopState();
    state.lastText = "Ответ оборвался посреди фразы";
    state.lastFinishReason = "length";
    state.auditFailed = true;
    state.lastAuditSummary = "audit failed";

    const tokenTracker = {
      resolveFinal: () => ({ prompt: 0, completion: 0, total: 0 }),
    } as unknown as TokenTracker;
    const host = {
      deps: {
        config: { maxToolIterations: 10 },
        contextManager: {
          getEstimatedTokens: () => 0,
          getBudget: () => ({ history: 1000 }),
          getCompactionCount: () => 0,
          getQuality: () => 0,
          getQualityBreakdown: () => undefined,
          getBreakdown: () => undefined,
        },
      },
      costTracker: { total: 0, saved: 0, breakdown: () => ({}) },
      isShutdownRequested: () => false,
    } as unknown as LoopResultHost;

    const result = buildLoopResult(host, state, tokenTracker, false);
    expect(result.success).toBe(false);
    expect(result.text).toContain("TRUNCATED");
    expect(result.text).toContain("Ответ оборвался посреди фразы");
  });
});
