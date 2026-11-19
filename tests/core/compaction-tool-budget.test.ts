/**
 * Спека 2026-11-01-compaction-history-capacity: порог компакции меряется
 * ёмкостью истории — окно минус reserve, фактический system и измеренные тулы,
 * а не конфигурной долей `budget.history` (она тулов не знает). До правки порог
 * на окне 32K с 9K тулов разрешал `used > window`.
 */
import { describe, expect, it } from "vitest";
import { ContextManager } from "../../src/core/context/manager";
import type { ContextBudget } from "../../src/config/types";

/** Счётчик «1 токен = 1 символ» — детерминированные оценки в тесте. */
const counter = { count: (text: string) => text.length };

/** Конфиг из живого прогона: 32K окно, system 10 %, reserve 15 %. */
const budget: ContextBudget = {
  systemPrompt: 0.1,
  responseReserve: 0.15,
  compactionThreshold: 0.75,
  compactionMinLoad: 0.5,
  policy: "v2",
};

/** Окно 32K: systemBudget 3276, reserve 4915, budget.history 24577. */
function makeContext(system: number, tools: number): ContextManager {
  const cm = new ContextManager(32_768, budget, counter as never);
  if (system > 0) cm.addMessage({ role: "system", content: "s".repeat(system) });
  cm.setToolTokens(tools);
  return cm;
}

describe("history capacity with measured tool tokens", () => {
  it("ёмкость = window − reserve − system − tools (и не больше budget.history)", () => {
    const cm = makeContext(3_093, 9_025);
    const b = cm.getBreakdown();
    expect(b.historyBudget).toBe(24_577); // конфигурная доля не изменилась
    expect(cm.getHistoryLimit()).toBe(32_768 - b.reserve - b.system - b.tools);
    expect(cm.getHistoryLimit()).toBe(15_735);
    expect(cm.getHistoryLimit()).toBeLessThanOrEqual(b.historyBudget);
  });

  it("жёсткий порог срабатывает до выхода за окно, а не на 40K истории", () => {
    const cm = makeContext(3_093, 9_025);
    // 15800 > ёмкости 15735, но < старого порога 24577.
    cm.addMessage({ role: "user", content: "u".repeat(15_800) });
    const check = cm.checkOverflowAllowed();
    expect(check.allowed).toBe(true);
    const b = cm.getBreakdown();
    // Промпт на пороге укладывается в окно с точностью до шага оценки.
    expect(b.used + b.reserve).toBeLessThanOrEqual(32_768 + 100);
  });

  it("soft-порог (75 %) тоже считается от ёмкости", () => {
    const cm = makeContext(3_093, 9_025);
    // 0.75 × 15735 = 11801; старый порог был 0.75 × 24577 = 18432.
    cm.addMessage({ role: "user", content: "u".repeat(11_850) });
    expect(cm.needsCompaction()).toBe(true);
  });

  it("без тулов конфигурная доля остаётся верхним пределом", () => {
    const cm = makeContext(500, 0);
    // window − reserve − system = 27353, но budget.history = 24577 меньше.
    expect(cm.getHistoryLimit()).toBe(24_577);
  });

  it("при тулах больше свободного окна ёмкость не отрицательна", () => {
    const cm = makeContext(1_000, 40_000);
    expect(cm.getHistoryLimit()).toBe(0);
    expect(cm.checkOverflowAllowed().allowed).toBe(false); // истории ещё нет
  });
});
