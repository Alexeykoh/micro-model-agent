import { describe, it, expect } from "bun:test";
import { PromptBuilder, omittedBlocksNote } from "../../src/core/prompt-builder";
import { resolvePromptOverflow } from "../../src/core/prompt-overflow-resolve";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { estimateTokens } from "../../src/llm/token-counter";
import type { PromptBlock } from "../../src/core/types";

function block(partial: Partial<PromptBlock> & { content: string }): PromptBlock {
  return {
    priority: "normal",
    essential: false,
    estimatedTokens: Math.ceil(partial.content.length / 4),
    ...partial,
  };
}

describe("B4: hint blocks carry their real weight", () => {
  it("overflow hint reports actual tokens, not the 60-token constant", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "mma-b4-"));
    try {
      const overflow = [
        block({ content: "A".repeat(4000), kind: "instructions", estimatedTokens: 1000 }),
        block({ content: "B".repeat(4000), kind: "project-map", estimatedTokens: 1000 }),
      ];
      const res = await resolvePromptOverflow({
        overflow,
        includedTokens: 500,
        systemBudget: 1200,
        provider: null, // сразу truncate — предсказуемо
        cacheDir,
        model: "m",
      });
      expect(res.hintBlock).not.toBeNull();
      const actual = estimateTokens(res.hintBlock!.content);
      expect(res.hintBlock!.estimatedTokens).toBe(actual);
      // Перечень из двух блоков + «read the full ...» длиннее прежних 60.
      expect(actual).toBeGreaterThan(60);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("omitted note is truncated to one line when the remaining budget is tight", () => {
    const excluded = Array.from({ length: 8 }, (_, i) =>
      block({ source: "skills", label: `catalog-${i}`, content: "x", estimatedTokens: 240 }),
    );
    const full = omittedBlocksNote(excluded);
    expect(full!.content).toContain("- skills: catalog-0");

    const tight = omittedBlocksNote(excluded, 30);
    expect(tight).not.toBeNull();
    expect(tight!.content).toContain("8 block(s) omitted");
    expect(tight!.estimatedTokens).toBeLessThanOrEqual(30);
  });

  it("omitted note is dropped entirely when even the compact form does not fit", () => {
    const excluded = [block({ source: "skills", label: "catalog", content: "x", estimatedTokens: 240 })];
    expect(omittedBlocksNote(excluded, 2)).toBeNull();
  });

  it("prompt assembled with an omitted note never exceeds the budget", () => {
    const budget = 220;
    const builder = new PromptBuilder(budget);
    builder.addBlock(block({ content: "core", priority: "critical", essential: true, estimatedTokens: 60 }));
    for (let i = 0; i < 6; i++) {
      builder.addBlock(block({ content: `b${i}`, label: `b${i}`, priority: "low", essential: false, estimatedTokens: 100 }));
    }
    const first = builder.build();
    const used = first.blocks.filter((b) => b.included).reduce((s, b) => s + b.tokens, 0);
    const note = omittedBlocksNote(first.excludedBlocks, Math.max(0, budget - used));
    if (note) builder.addBlock(note);
    const final = builder.build();
    const total = final.blocks.filter((b) => b.included).reduce((s, b) => s + b.tokens, 0);
    expect(total).toBeLessThanOrEqual(budget);
  });
});
