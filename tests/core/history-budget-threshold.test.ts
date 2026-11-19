/**
 * W2.1 (§3.1): пороги компакции сравнивают ИСТОРИЮ с бюджетом истории, а не
 * весь контекст (system + tools + history) с бюджетом истории.
 */
import { describe, expect, it } from "vitest";
import { ContextManager } from "../../src/core/context/manager";

/** Счётчик «1 токен = 1 символ» — детерминированные оценки в тесте. */
const counter = { count: (text: string) => text.length };

function makeContext(): ContextManager {
  // Окно 16K: бюджет истории ≈ 10.08K, порог 75 % ≈ 7.56K.
  return new ContextManager(16_000, undefined, counter as never);
}

describe("history budget thresholds", () => {
  it("does not compact a large system prompt plus a moderate history", () => {
    const cm = makeContext();
    cm.addMessage({ role: "system", content: "s".repeat(4_000) });
    cm.setToolTokens(1_000);
    cm.addMessage({ role: "user", content: "u".repeat(6_000) });

    // Полный контекст 11K > порога 7.56K, но сама история 6K < 7.56K.
    expect(cm.needsCompaction()).toBe(false);
  });

  it("compacts when the history itself crosses the threshold", () => {
    const cm = makeContext();
    cm.addMessage({ role: "system", content: "s".repeat(4_000) });
    cm.setToolTokens(1_000);
    cm.addMessage({ role: "user", content: "u".repeat(8_000) });

    expect(cm.needsCompaction()).toBe(true);
  });
});
