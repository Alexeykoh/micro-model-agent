import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ContextManager } from "../src/core/context/manager";
import { DEFAULTS } from "../src/config/defaults";
import {
  buildOldTurnsText,
  summarizeOldTurns,
} from "../src/core/context/compaction-llm-summary";
import type { LLMProvider } from "../src/llm/provider";

function fakeProvider(reply: string, fail = false): LLMProvider {
  return {
    model: "fake",
    contextWindow: 32768,
    async *chat() {
      if (fail) throw new Error("boom");
      yield { type: "text" as const, content: reply };
    },
    countTokens: (t: string) => Math.ceil(t.length / 4),
    listModels: async () => ["fake"],
  };
}

function tmpCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "compaction-llm-"));
}

describe("compaction llm summary", () => {
  it("summarizes old turns via provider and caches", async () => {
    const dir = tmpCacheDir();
    const provider = fakeProvider("- decided rockhopper\n- price 1200");
    const first = await summarizeOldTurns({
      provider,
      text: "user: compare bikes\ntool: prices rockhopper 1200",
      cacheDir: dir,
    });
    expect(first).toContain("rockhopper");
    // второй вызов того же текста — из кэша, провайдер не дёргается
    const second = await summarizeOldTurns({
      provider: fakeProvider("SHOULD NOT BE USED"),
      text: "user: compare bikes\ntool: prices rockhopper 1200",
      cacheDir: dir,
    });
    expect(second).toBe(first);
    expect(readdirSync(dir).length).toBe(1);
  });

  it("fails open (null) on provider error and empty input", async () => {
    const dir = tmpCacheDir();
    await expect(
      summarizeOldTurns({ provider: fakeProvider("x", true), text: "user: hi", cacheDir: dir }),
    ).resolves.toBeNull();
    await expect(
      summarizeOldTurns({ provider: fakeProvider("x"), text: "   ", cacheDir: dir }),
    ).resolves.toBeNull();
    await expect(
      summarizeOldTurns({ provider: null, text: "user: hi", cacheDir: dir }),
    ).resolves.toBeNull();
  });

  it("buildOldTurnsText flattens roles and caps length", () => {
    const text = buildOldTurnsText([
      { role: "user", content: "read files" },
      { role: "tool", content: "x".repeat(2000) },
    ]);
    expect(text).toContain("user: read files");
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).not.toContain("x".repeat(500));
  });

  it("injects [LLM summary] only in llm mode", () => {
    const mk = (mode: "ledger" | "llm") =>
      new ContextManager(32768, {
        ...DEFAULTS.contextBudget,
        compactionSummary: mode,
      });
    const seed = (mgr: ContextManager) => {
      for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `step ${i}` });
    };

    const llm = mk("llm");
    seed(llm);
    const withSummary = llm.compact({ keepLastN: 2, llmSummary: "- bikes compared" });
    expect(withSummary!.summary).toContain("[LLM summary]");
    expect(withSummary!.summary).toContain("bikes compared");

    const ledger = mk("ledger");
    seed(ledger);
    const ignored = ledger.compact({ keepLastN: 2, llmSummary: "- bikes compared" });
    expect(ignored!.summary).not.toContain("[LLM summary]");
  });

  it("getOldTurnsText returns old turns text, empty when nothing to compact", () => {
    const mgr = new ContextManager(32768, {
      ...DEFAULTS.contextBudget,
      compactionSummary: "llm",
    });
    mgr.addMessage({ role: "user", content: "hello" });
    expect(mgr.getOldTurnsText(2)).toBe("");
    for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `step ${i}` });
    expect(mgr.getOldTurnsText(2)).toContain("step 0");
    expect(mgr.getCompactionSummaryMode()).toBe("llm");
  });
});
