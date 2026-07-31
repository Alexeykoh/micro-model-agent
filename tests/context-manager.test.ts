import { describe, it, expect } from "vitest";
import { ContextManager } from "../src/modules/context/manager";

describe("ContextManager", () => {
  it("should calculate budget from context window", () => {
    const cm = new ContextManager(32768);
    const budget = cm.getBudget();
    expect(budget.systemPrompt).toBe(8192);
    expect(budget.responseReserve).toBe(3932);
    expect(budget.history).toBe(20643);
  });

  it("should add messages", () => {
    const cm = new ContextManager(32768);
    cm.addMessage({ role: "user", content: "hello" });
    expect(cm.getMessageCount()).toBe(1);
  });

  it("should detect compaction needed when history > 75%", () => {
    const cm = new ContextManager(100);
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: "x".repeat(10) });
    }
    expect(cm.needsCompaction()).toBe(true);
  });

  it("should compact old turns, keeping last 6", () => {
    const cm = new ContextManager(1000);
    cm.addMessage({ role: "system", content: "SYSTEM" });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `message ${i}` });
      cm.addMessage({ role: "assistant", content: `response ${i}` });
    }
    cm.compact();
    const history = cm.getActiveHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].role).toBe("system");
    expect(history[1].content).toContain("<system-summary>");
  });

  it("should not compact before threshold", () => {
    const cm = new ContextManager(100000);
    for (let i = 0; i < 3; i++) {
      cm.addMessage({ role: "user", content: "short" });
    }
    expect(cm.needsCompaction()).toBe(false);
  });

  it("should keep system prompt budget fixed", () => {
    const cm = new ContextManager(32768);
    expect(cm.getBudget().systemPrompt).toBe(8192);
  });
});
