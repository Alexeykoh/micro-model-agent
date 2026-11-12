import { describe, it, expect } from "bun:test";
import { PromptBuilder } from "../../src/core/prompt-builder";
import {
  resolvePromptOverflowOnce,
  type PromptPhaseHost,
} from "../../src/core/agent/prompt-phase";
import type { PromptBlock } from "../../src/core/types";

function block(partial: Partial<PromptBlock> & { content: string }): PromptBlock {
  return {
    priority: "normal",
    essential: false,
    estimatedTokens: Math.ceil(partial.content.length / 4),
    ...partial,
  };
}

/** Хост резолва с переопределяемым окном; essential-блок — 200 токенов. */
function resolveHost(contextWindow: number, warns: string[]): PromptPhaseHost {
  return {
    deps: {
      config: {
        model: "test-model",
        contextWindow,
        contextBudget: { systemPrompt: 0.1 },
        instructions: { summarize: false },
        provider: {},
      },
      configDir: "/tmp",
      baseDir: "/tmp",
      logger: {
        warn: (m: string) => warns.push(m),
        info: () => {},
        debug: () => {},
        error: () => {},
        logSilent: () => {},
      },
      promptBlocks: [
        block({ content: "SYSTEM-INFO", priority: "critical", essential: true, estimatedTokens: 200 }),
      ],
      getDynamicPromptBlocks: () => [],
      pluginManager: { runOnBuildPrompt: () => [] },
      toolExecutor: {
        getToolDefinitions: () => [],
        getVisibleTags: () => new Set<string>(),
      },
      llmProvider: { countTokens: (s: string) => Math.ceil(s.length / 4) },
      toolTags: [],
    },
    promptProfile: "full",
    promptOverrides: new Map(),
    overflowHintBlock: null,
    frozenMapBlock: null,
  } as unknown as PromptPhaseHost;
}

describe("essential budget guard (B3)", () => {
  it("flags essential blocks that exceed the budget but still includes them", () => {
    const builder = new PromptBuilder(100);
    builder.addBlock(block({ content: "A", priority: "critical", essential: true, estimatedTokens: 60 }));
    builder.addBlock(block({ content: "B", priority: "critical", essential: true, estimatedTokens: 60 }));
    const result = builder.build();
    expect(result.essentialTokens).toBe(120);
    expect(result.essentialOverBudget).toBe(true);
    // Essential не выбрасываем — но помечаем причину для /sysprompt и лога.
    expect(result.prompt).toContain("A");
    expect(result.prompt).toContain("B");
    expect(result.blocks.every((b) => b.reason?.includes("essential over budget"))).toBe(true);
  });

  it("stays quiet when essential blocks fit", () => {
    const builder = new PromptBuilder(200);
    builder.addBlock(block({ content: "A", priority: "critical", essential: true, estimatedTokens: 60 }));
    const result = builder.build();
    expect(result.essentialOverBudget).toBe(false);
    expect(result.blocks[0].reason).toBeUndefined();
  });

  it("warns once with a concrete fix when essential alone exceeds the budget", async () => {
    const warns: string[] = [];
    await resolvePromptOverflowOnce(resolveHost(1000, warns));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("200");
    expect(warns[0]).toContain("100");
  });

  it("does not warn when essential blocks fit", async () => {
    const warns: string[] = [];
    await resolvePromptOverflowOnce(resolveHost(10000, warns));
    expect(warns).toHaveLength(0);
  });
});
