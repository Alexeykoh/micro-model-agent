/**
 * W2.6: несжимаемый overflow не повторяется по кругу (§3.7 аудита).
 *
 * Если ужать контекст нечем, флаг `lastOverflowCompactionIteration` не ставится
 * — иначе каждая следующая итерация пробовала бы снова, без прогресса.
 */
import { describe, expect, it } from "vitest";
import { CompactionService } from "../../src/core/agent/compaction";
import { createLoopState } from "../../src/core/agent/loop-state";

/** Менеджер, который всегда «переполнен», но ужать не может. */
function makeDeps(overflowAllowed: boolean) {
  const compactions: string[] = [];
  const contextManager = {
    getPolicy: () => "v2",
    getOverflowCooldown: () => 3,
    checkOverflowAllowed: () => ({
      allowed: overflowAllowed,
      implausible: false,
      raw: 100,
      calibrated: 100,
    }),
    getBudget: () => ({ history: 1000 }),
    getContextTokens: () => 900,
    getToolResultKeep: () => 6,
    compactAdaptive: () => null,
    needsCompaction: () => false,
    getQuality: () => 80,
    needsIntervalCompaction: () => false,
    getKnownFiles: () => [],
  };
  const slog = { logCompaction: (info: { reason: string }) => compactions.push(info.reason) };
  const service = new CompactionService({
    contextManager: contextManager as never,
    logger: { debug: () => {}, diagnostic: () => {} } as never,
    slog: slog as never,
    hallucinationDetector: { addKnownFiles: () => {} } as never,
  });
  return { service, compactions, contextManager };
}

describe("overflow compaction without reduction", () => {
  it("does not arm the overflow cooldown when nothing can be reduced", () => {
    const { service, compactions, contextManager } = makeDeps(true);
    const state = createLoopState();
    state.iteration = 5;
    service.compactIfNeeded(state);

    expect(state.lastOverflowCompactionIteration).toBeLessThan(0);
    expect(compactions).toContain("skipped_no_reduction");

    // Следующая попытка (после общего кулдауна) снова честно сообщает о скипе.
    state.iteration = 9;
    service.compactIfNeeded(state);
    expect(compactions.filter((r) => r === "skipped_no_reduction").length).toBe(2);
    expect(contextManager.compactAdaptive).toBeDefined();
  });

  it("arms the cooldown only when the compaction really reduced the context", () => {
    const { service, contextManager } = makeDeps(true);
    (contextManager as { compactAdaptive: unknown }).compactAdaptive = () => ({
      reducedBy: 5000,
      strategy: "prune-tools",
      removedTurns: 3,
      keptTurns: 4,
      tokensBefore: 900,
      tokensAfter: 400,
      qualityBefore: 80,
      qualityAfter: 80,
      messagesBefore: 20,
      messagesAfter: 12,
      summary: "",
    });
    const state = createLoopState();
    state.iteration = 5;
    service.compactIfNeeded(state);
    expect(state.lastOverflowCompactionIteration).toBe(5);
  });
});
