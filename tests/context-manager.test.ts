import { describe, it, expect } from "vitest";
import { ContextManager, extractTriedAndFailed } from "../src/modules/context/manager";
import type { Message } from "../src/modules/context/manager";

describe("ContextManager", () => {
  it("compaction cutoff keeps assistant(tool_calls) with its tool messages", () => {
    const cm = new ContextManager(32768);
    // 17 messages → initial cutoff = 17 - 12 = 5, which lands on the second
    // tool message of the group at indices 3 (assistant) / 4,5 (tools).
    cm.addMessage({ role: "user", content: "task" });
    cm.addMessage({ role: "assistant", content: "working" });
    cm.addMessage({ role: "user", content: "filler" });
    cm.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "list_dir", arguments: "{}" } },
      ],
    });
    cm.addMessage({ role: "tool", content: "contents", name: "read_file", tool_call_id: "c1" });
    cm.addMessage({ role: "tool", content: "a,b", name: "list_dir", tool_call_id: "c2" });
    for (let i = 0; i < 5; i++) {
      cm.addMessage({ role: "user", content: `filler ${i}` });
      cm.addMessage({ role: "assistant", content: `reply ${i}` });
    }
    cm.addMessage({ role: "user", content: "final question" });
    const result = cm.compact();
    expect(result).not.toBeNull();

    const history = cm.getActiveHistory();
    const summaryIdx = history.findIndex(
      (m) => m.role === "user" && String(m.content).startsWith("<system-summary>"),
    );
    const kept = history.slice(summaryIdx + 1);
    // The first kept message is the assistant(tool_calls) — not an orphaned
    // role:"tool" message split from its parent.
    expect(kept[0].role).toBe("assistant");
    expect(kept[0].tool_calls?.map((tc) => tc.id)).toEqual(["c1", "c2"]);
    expect(kept[1]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(kept[2]).toMatchObject({ role: "tool", tool_call_id: "c2" });
  });

  it("compaction cutoff moves a trailing dangling assistant(tool_calls) into the kept part", () => {
    const cm = new ContextManager(32768);
    // 16 messages → cutoff = 4, landing right AFTER an assistant(tool_calls)
    // whose results are missing — the assistant must move into the kept part.
    cm.addMessage({ role: "user", content: "task" });
    cm.addMessage({ role: "assistant", content: "working" });
    cm.addMessage({ role: "user", content: "filler" });
    cm.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    });
    for (let i = 0; i < 6; i++) {
      cm.addMessage({ role: "user", content: `filler ${i}` });
      cm.addMessage({ role: "assistant", content: `reply ${i}` });
    }
    const result = cm.compact();
    expect(result).not.toBeNull();

    const history = cm.getActiveHistory();
    const summaryIdx = history.findIndex(
      (m) => m.role === "user" && String(m.content).startsWith("<system-summary>"),
    );
    const kept = history.slice(summaryIdx + 1);
    expect(kept[0].role).toBe("assistant");
    expect(kept[0].tool_calls?.map((tc) => tc.id)).toEqual(["c1"]);
    expect(kept.some((m) => m.role === "tool")).toBe(false);
  });

  it("caches per-message token counts across getEstimatedTokens calls", () => {
    let countCalls = 0;
    const counter = { count: (s: string) => { countCalls++; return Math.ceil(s.length / 2); } };
    const cm = new ContextManager(32768, undefined, counter as any);
    for (let i = 0; i < 50; i++) cm.addMessage({ role: "user", content: `message number ${i} with some content` });
    cm.getEstimatedTokens();
    const callsAfterFirst = countCalls;
    cm.getEstimatedTokens();
    cm.getEstimatedTokens();
    cm.getEstimatedTokens();
    expect(countCalls).toBe(callsAfterFirst);
  });

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
    const summary = history.find(
      (m) => typeof m.content === "string" && m.content.includes("[Compressed:"),
    );
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

describe("ContextManager compaction interval reset between user turns", () => {
  it("should not trigger interval compaction right after reset", () => {
    const cm = new ContextManager(100000);
    for (let i = 0; i < 14; i++) {
      cm.addMessage({ role: "user", content: `task ${i}` });
      cm.noteIteration();
    }
    // 14 iterations — still below COMPACTION_INTERVAL (15)
    expect(cm.needsCompaction()).toBe(false);

    cm.noteIteration(); // iteration 15
    expect(cm.needsCompaction()).toBe(true);
  });

  it("should not inherit the previous turn's compaction interval", () => {
    // Turn 1 leaves 14 iterations since the last compaction.
    const cm = new ContextManager(100000);
    for (let i = 0; i < 14; i++) cm.noteIteration();

    // Turn 2 starts — the agent calls resetUserTurn() so the 14 iterations
    // from turn 1 must NOT count toward the new turn's 15-iteration interval.
    cm.resetUserTurn();
    expect(cm.needsCompaction()).toBe(false);

    for (let i = 0; i < 14; i++) cm.noteIteration();
    expect(cm.needsCompaction()).toBe(false);
  });

  it("should keep file facts across turns while resetting the interval", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({
      role: "tool",
      name: "write_file",
      content: "Written bicycle-shop/src/App.tsx",
      success: true,
    });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `more ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.compact();
    expect(
      cm.getActiveHistory().some((m) => {
        const text = typeof m.content === "string" ? m.content : "";
        return text.includes("bicycle-shop/src/App.tsx");
      }),
    ).toBe(true);

    cm.resetUserTurn();
    expect(cm.needsCompaction()).toBe(false);
  });
});

describe("ContextManager fact extraction", () => {
  it("preserves the latest real user task in the compaction summary", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({
      role: "user",
      content: "удали /bicycles, почини стили на /bicycle/2",
    });
    // Interleave enough turns so the user task lands in oldTurns at compaction.
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `tool result ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("удали /bicycles, почини стили на /bicycle/2");
  });

  it("does not treat system-summary blocks as the user task", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({ role: "user", content: "REAL TASK: fix the bug" });
    cm.addMessage({
      role: "user",
      content: "<system-summary>[Retry context: empty response]</system-summary>",
    });
    cm.addMessage({ role: "user", content: "some tool output" });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `more ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("REAL TASK: fix the bug");
    expect(summary).not.toContain("Retry context");
  });

  it("resetUserTurn clears the task so a new user message wins", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "user", content: "OLD TASK: fix router" });
    cm.resetUserTurn();
    cm.addMessage({ role: "user", content: "NEW TASK: remove /bicycles" });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `tool ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("NEW TASK: remove /bicycles");
    expect(summary).not.toContain("OLD TASK");
  });

  it("keeps the original task when the user pastes an error/log block", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({ role: "user", content: "удали JS-дубликаты, оставь только .tsx" });
    cm.resetUserTurn();
    const paste = `[plugin:vite:esbuild] Transform failed with 1 error:
E:/projects/mma_tests/bicycle-shop/src/ProductPage.tsx:270:7: ERROR: Multiple exports with the same name "default"

268| export default ProductPage;var _c;$RefreshReg$(_c, "ProductPage");
271| if (import.meta.hot && !inWebWorker) {`;
    cm.addMessage({ role: "user", content: paste });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `t ${i}` });
      cm.addMessage({ role: "assistant", content: `r ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("[Task: удали JS-дубликаты, оставь только .tsx]");
    expect(summary).toContain("[User feedback:");
    expect(summary).not.toContain("[Task: [plugin:vite:esbuild]");
  });

  it("keeps a long legitimate task as the task (no error markers)", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    const longTask =
      "Переработай страницу каталога: добавь фильтры по категории и цене, " +
      "сортировку по популярности и новинкам, пагинацию по 12 товаров, " +
      "адаптивную сетку карточек и полную типизацию props и state.";
    cm.addMessage({ role: "user", content: longTask });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `t ${i}` });
      cm.addMessage({ role: "assistant", content: `r ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("[Task: Переработай страницу каталога");
  });

  it("classifies a short error-marked paste as feedback", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({ role: "user", content: "почини страницу" });
    cm.resetUserTurn();
    cm.addMessage({ role: "user", content: "Error: Cannot find module './Header'" });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `t ${i}` });
      cm.addMessage({ role: "assistant", content: `r ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("[Task: почини страницу]");
    expect(summary).toContain("[User feedback: Error: Cannot find module './Header']");
  });

  it("should extract 'Replaced in <path>' (edit_file output) as a file fact", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({
      role: "tool",
      name: "edit_file",
      content: "Replaced in bicycle-shop/src/App.tsx",
      success: true,
    });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `more ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("bicycle-shop/src/App.tsx");
  });

  it("should extract 'Written <path>' (write_file output) as a file fact", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({
      role: "tool",
      name: "write_file",
      content: "Written E:\\projects\\mma_tests\\bicycle-shop\\src\\DeliveryPage.tsx",
      success: true,
    });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `more ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(summary).toContain("DeliveryPage.tsx");
  });

  it("removes deleted files from the files fact list and reports them as deleted", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    // write src/a.js + write src/b.js + delete src/a.js + write src/a.js again:
    // the re-created file must leave [Deleted:] and return to [Files:], while
    // the untouched src/b.js survives in [Files:].
    cm.addMessage({
      role: "tool",
      name: "write_file",
      content: "Written src/a.js",
      success: true,
    });
    cm.addMessage({
      role: "tool",
      name: "write_file",
      content: "Written src/b.js",
      success: true,
    });
    cm.addMessage({
      role: "tool",
      name: "delete_file",
      content: "Deleted src/a.js",
      success: true,
    });
    cm.addMessage({
      role: "tool",
      name: "write_file",
      content: "Written src/a.js",
      success: true,
    });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `more ${i}` });
      cm.addMessage({ role: "assistant", content: `r ${i}` });
    }
    cm.compact();
    const summary = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    const deletedBlock = summary.match(/\[Deleted: ([^\]]*)\]/)?.[1] ?? "";
    expect(deletedBlock).not.toContain("src/a.js");
    const filesBlock = summary.match(/\[Files: ([^\]]*)\]/)?.[1] ?? "";
    expect(filesBlock).toContain("src/a.js");
    expect(filesBlock).toContain("src/b.js");
    expect(summary).not.toContain("[Deleted: src/a.js]");
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

describe("ContextManager compaction result", () => {
  it("returns null when there is nothing to compact", () => {
    const cm = new ContextManager(1000);
    cm.addMessage({ role: "user", content: "hello" });
    cm.addMessage({ role: "assistant", content: "hi" });
    expect(cm.compact()).toBeNull();
    expect(cm.getCompactionCount()).toBe(0);
  });

  it("returns before/after token, quality and turn counts", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYSTEM" });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `message ${i} `.repeat(40) });
      cm.addMessage({ role: "assistant", content: `response ${i} `.repeat(40) });
    }
    cm.noteIteration();
    const tokensBefore = cm.getEstimatedTokens();
    const qualityBefore = cm.getQuality();
    const result = cm.compact();
    expect(result).not.toBeNull();
    expect(result!.removedTurns).toBeGreaterThan(0);
    expect(result!.keptTurns).toBeGreaterThan(0);
    expect(result!.tokensBefore).toBe(tokensBefore);
    expect(result!.qualityBefore).toBe(qualityBefore);
    expect(result!.tokensAfter).toBeLessThan(result!.tokensBefore);
    expect(result!.summary).toContain("[Compressed:");
    expect(result!.summary).toContain("[Task:");
  });

  it("returns keptTurns for the recent turns that survive verbatim", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYSTEM" });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `message ${i}` });
      cm.addMessage({ role: "assistant", content: `response ${i}` });
    }
    const result = cm.compact();
    // 21 messages (system + 10 user + 10 assistant); cutoff = 21-12 = 9
    // removed (system + 8), last 12 kept verbatim
    expect(result!.removedTurns).toBe(9);
    expect(result!.keptTurns).toBe(12);
  });
});

describe("ContextManager snapshot", () => {
  it("reports budget, tokens, quality and compaction state", () => {
    const cm = new ContextManager(32768);
    cm.addMessage({ role: "user", content: "hello" });
    cm.setToolTokens(100);
    const snap = cm.getSnapshot();
    expect(snap.window).toBe(32768);
    expect(snap.budget.history).toBe(20643);
    expect(snap.tokens).toBeGreaterThan(0);
    expect(snap.toolTokens).toBe(100);
    expect(snap.messageCount).toBe(1);
    expect(snap.quality).toBeGreaterThanOrEqual(0);
    expect(snap.compactionCount).toBe(0);
    expect(snap.iterationsSinceCompaction).toBe(0);
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

describe("ContextManager compaction: plan state + read facts", () => {
  function summaryOf(cm: ContextManager): string {
    return cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
  }

  it("includes an active-plan line from the injected provider", () => {
    const cm = new ContextManager(100000);
    cm.setPlanSummaryProvider(() => '[plan_abc] "T" 1/3 done, current: step 2');
    cm.addMessage({ role: "system", content: "SYS" });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `t ${i}` });
      cm.addMessage({ role: "assistant", content: `r ${i}` });
    }
    cm.compact();
    expect(summaryOf(cm)).toContain('[Plan: [plan_abc] "T" 1/3 done, current: step 2');
  });

  it("omits the plan line when the provider returns null", () => {
    const cm = new ContextManager(100000);
    cm.setPlanSummaryProvider(() => null);
    cm.addMessage({ role: "system", content: "SYS" });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `t ${i}` });
      cm.addMessage({ role: "assistant", content: `r ${i}` });
    }
    cm.compact();
    expect(summaryOf(cm)).not.toContain("[Plan:");
  });

  it("extracts read_file headers as [Read:] facts so the model knows what was inspected", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({
      role: "tool",
      name: "read_file",
      content: "── src/App.tsx (.tsx, 300 lines, lines 1-300)\nexport function App() {}",
      success: true,
    });
    cm.addMessage({
      role: "tool",
      name: "read_file",
      content: "── src/main.tsx (.tsx, 15 lines, lines 1-15)",
      success: true,
    });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `more ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.compact();
    const summary = summaryOf(cm);
    expect(summary).toContain("[Read: src/App.tsx; src/main.tsx]");
    // Read facts must NOT leak into [Files:] (created/updated semantics).
    const filesBlock = summary.match(/\[Files: ([^\]]*)\]/)?.[1] ?? "";
    expect(filesBlock).not.toContain("App.tsx");
  });

  it("never extracts error facts from the system prompt (memory errors.md is history, not live)", () => {
    // Regression (ses_msvuao0h): the memory module embeds errors.md in the
    // system prompt, and the old un-gated error scan pulled a stale
    // "edit_file failed 3x" (2026-08-15) into every [Errors:] as if it were
    // the live session's failure.
    const cm = new ContextManager(100000);
    cm.addMessage({
      role: "system",
      content: "SYS Memory: 2026-08-15 Tool edit_file failed 3x: Error: TS2769",
    });
    for (let i = 0; i < 12; i++) {
      cm.addMessage({ role: "user", content: `t ${i}` });
      cm.addMessage({ role: "assistant", content: `r ${i}` });
    }
    cm.compact();
    const summary = summaryOf(cm);
    // The system prompt itself survives compaction verbatim (it is always kept
    // first) — the point is that the stale error is NOT folded into the
    // summary's fact block as a live failure.
    expect(summary).not.toContain("[Errors:");
    expect(summary).not.toContain("[Errors: Error: TS2769]");
  });

  it("still extracts error facts from tool messages", () => {
    const cm = new ContextManager(100000);
    cm.addMessage({ role: "system", content: "SYS" });
    cm.addMessage({
      role: "tool",
      name: "bash",
      content: "Error: build failed",
      success: false,
    });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `more ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    cm.compact();
    expect(summaryOf(cm)).toContain("[Errors: Error: build failed]");
  });
});
