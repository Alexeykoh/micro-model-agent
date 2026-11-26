// AQC-5: для окна ≤64K компакция срабатывает до 60 сообщений, а не на 159-м,
// как в сессии ses_mwor4q49. Quality-триггер больше не требует уже случившейся
// компакции (куриное яйцо).
import { describe, it, expect } from "vitest";
import { ContextManager } from "../../src/core/context/manager";
import { CompactionService } from "../../src/core/agent/compaction";
import { createLoopState } from "../../src/core/agent/loop-state";
import { EARLY_SMALL_MESSAGE_COUNT } from "../../src/core/agent/constants";

function budget() {
  return {
    systemPrompt: 0.1,
    responseReserve: 0.1,
    compactionThreshold: 0.75,
    compactionMinLoad: 0.5,
    policy: "v2" as const,
  };
}

function service(cm: ContextManager, reasons: string[]) {
  const logger = {
    debug: () => {},
    diagnostic: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as never;
  const slog = { logCompaction: (i: { reason: string }) => reasons.push(i.reason) } as never;
  const hallucinationDetector = { addKnownFiles: () => {} } as never;
  return new CompactionService({ contextManager: cm, logger, slog, hallucinationDetector });
}

describe("AQC-5: ранняя компакция маленьких моделей", () => {
  it("компактим до 60 сообщений при окне 32K", async () => {
    const cm = new ContextManager(32768, budget());
    cm.addMessage({ role: "system", content: "system" });
    for (let i = 0; i < EARLY_SMALL_MESSAGE_COUNT + 2; i++) {
      cm.addMessage({ role: "user", content: `message ${i} ${"x".repeat(200)}` });
      cm.addMessage({ role: "assistant", content: `reply ${i} ${"y".repeat(200)}` });
    }
    const before = cm.getMessageCount();
    expect(before).toBeGreaterThan(EARLY_SMALL_MESSAGE_COUNT);

    const reasons: string[] = [];
    const state = createLoopState();
    state.iteration = 10;
    state.lastCompactionIteration = 0;
    await service(cm, reasons).compactIfNeeded(state);

    expect(reasons).toContain("early-small-model");
    expect(cm.getMessageCount()).toBeLessThan(before);
  });

  it("большое окно не трогаем", async () => {
    const cm = new ContextManager(200000, budget());
    for (let i = 0; i < EARLY_SMALL_MESSAGE_COUNT + 2; i++) {
      cm.addMessage({ role: "user", content: `message ${i}` });
    }
    const reasons: string[] = [];
    const state = createLoopState();
    state.iteration = 10;
    state.lastCompactionIteration = 0;
    await service(cm, reasons).compactIfNeeded(state);
    expect(reasons.some((r) => r.includes("early-small-model"))).toBe(false);
  });
});
