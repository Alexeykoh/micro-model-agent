// Политика компакции v2: прогресс, cooldown, no-op, safety-clamp, реактивность.
import { describe, it, expect } from "vitest";
import { ContextManager } from "../src/modules/context/manager";
import { CompactionService } from "../src/core/agent/compaction";
import { createLoopState } from "../src/core/agent/loop-state";
import { classifyProviderError } from "../src/llm/openai-compat";

function budget(overrides: Record<string, number | string> = {}) {
  return {
    systemPrompt: 0.1,
    responseReserve: 0.1,
    compactionThreshold: 0.75,
    compactionMinLoad: 0.5,
    policy: "v2" as const,
    ...overrides,
  };
}

function makeService(cm: ContextManager, logs: string[]) {
  const logger = {
    debug: () => {},
    diagnostic: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as never;
  const slog = {
    logCompaction: (info: { reason: string }) => logs.push(info.reason),
  } as never;
  const hallucinationDetector = { addKnownFiles: () => {} } as never;
  return new CompactionService({ contextManager: cm, logger, slog, hallucinationDetector });
}

describe("ContextManager v2 compaction", () => {
  it("reports reducedBy and strategy", () => {
    const cm = new ContextManager(100000, budget());
    for (let i = 0; i < 40; i++) {
      cm.addMessage({ role: "user", content: `task ${i}`, });
      cm.addMessage({ role: "tool", content: "x".repeat(2000), name: "read_file" });
    }
    const res = cm.compact({ minReduction: 0 });
    expect(res).not.toBeNull();
    expect(res!.reducedBy).toBeGreaterThan(0);
    expect(res!.strategy).toBe("summarize");
  });

  it("does not count a no-op below minReduction", () => {
    const cm = new ContextManager(100000, budget());
    for (let i = 0; i < 20; i++) {
      cm.addMessage({ role: "user", content: `m${i}` });
      cm.addMessage({ role: "assistant", content: `a${i}` });
    }
    cm.compact({ minReduction: 10_000_000 });
    expect(cm.getCompactionCount()).toBe(0);
  });

  it("pruneStaleToolResults keeps the newest tool results and recent messages", () => {
    const cm = new ContextManager(100000, budget());
    cm.addMessage({ role: "user", content: "go" });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "assistant", content: `step ${i}` });
      cm.addMessage({ role: "tool", content: `TOOL_BODY_${i}_`.repeat(100), name: "t" });
    }
    const pruned = cm.pruneStaleToolResults(2, 6);
    expect(pruned).toBeGreaterThan(0);
    const history = cm.getActiveHistory();
    const toolMsgs = history.filter((m) => m.role === "tool");
    // Последние 2 tool-результата сохранены дословно.
    expect(String(toolMsgs[toolMsgs.length - 1].content)).toContain("TOOL_BODY_9");
    // Ранние — обнулены.
    expect(String(toolMsgs[0].content)).toContain("pruned");
  });

  it("compactAdaptive makes progress when normal summarization is insufficient", () => {
    const cm = new ContextManager(100000, budget());
    // Много огромных tool-результатов, compact оставит последние 12 сообщений.
    for (let i = 0; i < 60; i++) {
      cm.addMessage({ role: "assistant", content: `step ${i}` });
      cm.addMessage({ role: "tool", content: "Z".repeat(5000), name: "t" });
    }
    const before = cm.getEstimatedTokens();
    const res = cm.compactAdaptive({ toolResultKeep: 2, minReduction: 0 });
    expect(res).not.toBeNull();
    expect(cm.getEstimatedTokens()).toBeLessThan(before);
    expect(res!.reducedBy).toBeGreaterThan(0);
  });

  it("exposes policy getters", () => {
    const cm = new ContextManager(1000, budget({ policy: "legacy", overflowCooldown: 7, toolResultKeep: 3 }));
    expect(cm.getPolicy()).toBe("legacy");
    expect(cm.getOverflowCooldown()).toBe(7);
    expect(cm.getToolResultKeep()).toBe(3);
  });
});

describe("CompactionService v2 overflow cooldown", () => {
  it("triggers overflow at most once per cooldown window", () => {
    const cm = new ContextManager(1200, budget({ overflowCooldown: 5 }));
    // Переполняем историю.
    for (let i = 0; i < 40; i++) {
      cm.addMessage({ role: "assistant", content: `step ${i}` });
      cm.addMessage({ role: "tool", content: "Q".repeat(3000), name: "t" });
    }
    const logs: string[] = [];
    const svc = makeService(cm, logs);
    const state = createLoopState();
    state.iteration = 1;
    svc.compactIfNeeded(state);
    const afterFirst = logs.length;
    state.iteration = 2; // внутри cooldown
    svc.compactIfNeeded(state);
    expect(logs.length).toBe(afterFirst);
  });
});

describe("classifyProviderError", () => {
  it("classifies explicit context-length errors", () => {
    expect(classifyProviderError("This model's maximum context length is 4096 tokens")).toBe(
      "context_length",
    );
    expect(classifyProviderError("input is too long for this model")).toBe("context_length");
  });

  it("fails open on unrelated errors", () => {
    expect(classifyProviderError("invalid api key")).toBeUndefined();
    expect(classifyProviderError("")).toBeUndefined();
  });
});
