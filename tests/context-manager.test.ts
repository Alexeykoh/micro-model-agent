import { describe, it, expect } from "vitest";
import { ContextManager, extractTriedAndFailed } from "../src/modules/context/manager";
import type { Message } from "../src/modules/context/manager";

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

describe("extractTriedAndFailed", () => {
  it("should extract repeated failures from tool messages", () => {
    const messages: Message[] = [
      { role: "tool", name: "write_file", arguments: { path: "src/index.ts" }, content: "TS2769 error", success: false },
      { role: "tool", name: "write_file", arguments: { path: "src/index.ts" }, content: "TS2769 error", success: false },
      { role: "tool", name: "write_file", arguments: { path: "src/index.ts" }, content: "TS2769 error", success: false },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe("write_file");
    expect(result[0].count).toBe(3);
    expect(result[0].error).toContain("TS2769");
  });

  it("should not include failures with count < 2", () => {
    const messages: Message[] = [
      { role: "tool", name: "bash", arguments: { command: "npm test" }, content: "exit code 1", success: false },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(0);
  });

  it("should not include successful tool calls", () => {
    const messages: Message[] = [
      { role: "tool", name: "write_file", arguments: { path: "a.ts" }, content: "ok", success: true },
      { role: "tool", name: "write_file", arguments: { path: "a.ts" }, content: "ok", success: true },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(0);
  });

  it("should track different tools separately", () => {
    const messages: Message[] = [
      { role: "tool", name: "bash", arguments: { command: "test" }, content: "fail", success: false },
      { role: "tool", name: "bash", arguments: { command: "test" }, content: "fail", success: false },
      { role: "tool", name: "write_file", arguments: { path: "a.ts" }, content: "error", success: false },
      { role: "tool", name: "write_file", arguments: { path: "a.ts" }, content: "error", success: false },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.tool === "bash")!.count).toBe(2);
    expect(result.find((r) => r.tool === "write_file")!.count).toBe(2);
  });

  it("should truncate long error messages to 100 chars", () => {
    const longError = "x".repeat(200);
    const messages: Message[] = [
      { role: "tool", name: "bash", arguments: { command: "test" }, content: longError, success: false },
      { role: "tool", name: "bash", arguments: { command: "test" }, content: longError, success: false },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(1);
    expect(result[0].error.length).toBeLessThanOrEqual(100);
  });
});
