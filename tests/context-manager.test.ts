import { describe, it, expect } from "vitest";
import {
  ContextManager,
  extractTriedAndFailed,
} from "../src/modules/context/manager";
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

  it("should not embed previous system-summary text into new error facts", () => {
    // Round 1: put an error message deep enough that it lands in oldTurns at
    // compaction, so summary1 has an "[Errors: ...]" section.
    const cm = new ContextManager(1000);
    cm.addMessage({ role: "system", content: "SYS" });
    for (let i = 0; i < 5; i++) {
      cm.addMessage({ role: "user", content: `task ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.addMessage({ role: "tool", name: "bash", content: "Error: build failed", success: false });
    for (let i = 0; i < 7; i++) {
      cm.addMessage({ role: "user", content: `more ${i}` });
      cm.addMessage({ role: "assistant", content: `more resp ${i}` });
    }
    cm.compact();

    // Round 2: now summary1 (with its "[Errors: Error: build failed]" text) is
    // old enough to be consumed by extractFacts again. It must NOT be captured
    // as a nested error fact.
    for (let i = 0; i < 8; i++) {
      cm.addMessage({ role: "user", content: `even more ${i}` });
      cm.addMessage({ role: "assistant", content: `even more resp ${i}` });
    }
    cm.addMessage({ role: "tool", name: "bash", content: "Error: tests failed", success: false });
    cm.compact();

    const history = cm.getActiveHistory();
    const summary = history.find((m) => typeof m.content === "string" && m.content.includes("[Compressed:"));
    expect(summary).toBeDefined();
    const text = typeof summary!.content === "string" ? summary!.content : "";
    const occurrences = text.split("<system-summary>").length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
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

describe("getQuality", () => {
  it("should return ~100 for empty context", () => {
    const cm = new ContextManager(32768);
    const q = cm.getQuality();
    expect(q).toBeGreaterThanOrEqual(95);
    expect(q).toBeLessThanOrEqual(100);
  });

  it("should decrease as tokens fill up", () => {
    const cm = new ContextManager(1000);
    const q1 = cm.getQuality();
    for (let i = 0; i < 20; i++) {
      cm.addMessage({ role: "user", content: "x".repeat(200) });
    }
    const q2 = cm.getQuality();
    expect(q2).toBeLessThan(q1);
  });

  it("should decrease after compaction", () => {
    const cm = new ContextManager(1000);
    const q1 = cm.getQuality();
    cm.addMessage({ role: "system", content: "SYS" });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `msg ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.compact();
    const q2 = cm.getQuality();
    expect(q2).toBeLessThan(q1);
  });

  it("should decrease with iterations", () => {
    const cm = new ContextManager(32768);
    const q1 = cm.getQuality();
    cm.noteIteration();
    cm.noteIteration();
    cm.noteIteration();
    const q2 = cm.getQuality();
    expect(q2).toBeLessThan(q1);
  });

  it("should always be between 0 and 100", () => {
    const cm = new ContextManager(100);
    for (let i = 0; i < 50; i++) {
      cm.addMessage({ role: "user", content: "x".repeat(100) });
    }
    for (let i = 0; i < 30; i++) cm.noteIteration();
    const q = cm.getQuality();
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(100);
  });

  it("should not permanently zero out quality after many compactions", () => {
    // Regression: compactionLoss = max(0, 1 - compactionCount*0.15) becomes 0
    // forever after ~7 compactions. In a heavy session (tokenLoad and
    // errorDensity both low) that permanently pins quality below the 40%
    // forced-compaction trigger → a compaction fires on EVERY iteration.
    const cm = new ContextManager(1000);
    for (let c = 0; c < 20; c++) {
      for (let i = 0; i < 7; i++) {
        cm.addMessage({ role: "user", content: "u".repeat(200) });
        cm.addMessage({ role: "assistant", content: "a".repeat(200) });
      }
      cm.compact();
    }
    expect(cm.getCompactionCount()).toBeGreaterThanOrEqual(7);
    expect(cm.getQuality()).toBeGreaterThanOrEqual(40);
  });

  it("should keep quality at least 40 with fresh context and high compaction count", () => {
    const cm = new ContextManager(1000);
    for (let c = 0; c < 10; c++) {
      for (let i = 0; i < 7; i++) {
        cm.addMessage({ role: "user", content: "u".repeat(300) });
        cm.addMessage({ role: "assistant", content: "a".repeat(300) });
      }
      cm.compact();
    }
    expect(cm.getCompactionCount()).toBeGreaterThanOrEqual(7);
    expect(cm.getQuality()).toBeGreaterThanOrEqual(40);
  });
});

describe("extractTriedAndFailed", () => {
  it("should extract repeated failures from tool messages", () => {
    const messages: Message[] = [
      {
        role: "tool",
        name: "write_file",
        arguments: { path: "src/index.ts" },
        content: "TS2769 error",
        success: false,
      },
      {
        role: "tool",
        name: "write_file",
        arguments: { path: "src/index.ts" },
        content: "TS2769 error",
        success: false,
      },
      {
        role: "tool",
        name: "write_file",
        arguments: { path: "src/index.ts" },
        content: "TS2769 error",
        success: false,
      },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe("write_file");
    expect(result[0].count).toBe(3);
    expect(result[0].error).toContain("TS2769");
  });

  it("should not include failures with count < 2", () => {
    const messages: Message[] = [
      {
        role: "tool",
        name: "bash",
        arguments: { command: "npm test" },
        content: "exit code 1",
        success: false,
      },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(0);
  });

  it("should not include successful tool calls", () => {
    const messages: Message[] = [
      {
        role: "tool",
        name: "write_file",
        arguments: { path: "a.ts" },
        content: "ok",
        success: true,
      },
      {
        role: "tool",
        name: "write_file",
        arguments: { path: "a.ts" },
        content: "ok",
        success: true,
      },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(0);
  });

  it("should track different tools separately", () => {
    const messages: Message[] = [
      {
        role: "tool",
        name: "bash",
        arguments: { command: "test" },
        content: "fail",
        success: false,
      },
      {
        role: "tool",
        name: "bash",
        arguments: { command: "test" },
        content: "fail",
        success: false,
      },
      {
        role: "tool",
        name: "write_file",
        arguments: { path: "a.ts" },
        content: "error",
        success: false,
      },
      {
        role: "tool",
        name: "write_file",
        arguments: { path: "a.ts" },
        content: "error",
        success: false,
      },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.tool === "bash")!.count).toBe(2);
    expect(result.find((r) => r.tool === "write_file")!.count).toBe(2);
  });

  it("should truncate long error messages to 100 chars", () => {
    const longError = "x".repeat(200);
    const messages: Message[] = [
      {
        role: "tool",
        name: "bash",
        arguments: { command: "test" },
        content: longError,
        success: false,
      },
      {
        role: "tool",
        name: "bash",
        arguments: { command: "test" },
        content: longError,
        success: false,
      },
    ];
    const result = extractTriedAndFailed(messages);
    expect(result).toHaveLength(1);
    expect(result[0].error.length).toBeLessThanOrEqual(100);
  });
});
