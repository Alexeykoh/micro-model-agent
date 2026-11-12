import { describe, it, expect } from "bun:test";
import {
  buildSystemPrompt,
  getSystemPromptInfo,
  type PromptPhaseHost,
} from "../../src/core/agent/prompt-phase";
import { estimateTokens } from "../../src/llm/token-counter";

/**
 * B2: учёт бюджета промпта — одной линейкой (`estimateTokens`).
 * Провайдерский `countTokens` (здесь заглушка возвращает абсурд) на решение
 * «влез/не влез» и на цифры `/sysprompt` влиять не должен.
 */
function hostWithAbsurdCounter(promptProfile: "full" | "service-job"): PromptPhaseHost {
  return {
    deps: {
      config: {
        model: "test-model",
        contextWindow: 32768,
        contextBudget: { systemPrompt: 0.1 },
      },
      promptBlocks: [],
      getDynamicPromptBlocks: () => [],
      pluginManager: { runOnBuildPrompt: () => ["x".repeat(100)] },
      toolExecutor: { getToolDefinitions: () => [{ name: "a" }, { name: "b" }] },
      // Абсурд: если хоть один учёт возьмёт эту линейку — бюджет порвётся.
      llmProvider: { countTokens: () => 999999 },
      toolTags: [],
    },
    promptProfile,
    promptOverrides: new Map(),
    overflowHintBlock: null,
    frozenMapBlock: null,
  } as unknown as PromptPhaseHost;
}

describe("prompt budget single ruler (B2)", () => {
  it("budgets plugin blocks with estimateTokens, not provider countTokens", () => {
    const build = buildSystemPrompt(hostWithAbsurdCounter("full"));
    const plugin = build.blocks.find((b) => b.label.includes("capabilities"));
    expect(plugin).toBeDefined();
    expect(plugin!.included).toBe(true);
    expect(plugin!.tokens).toBeLessThan(100);
  });

  it("reports service-job and /sysprompt sizes with estimateTokens", () => {
    const host = hostWithAbsurdCounter("service-job");
    const build = buildSystemPrompt(host);
    expect(build.blocks).toHaveLength(1);
    expect(build.blocks[0].tokens).toBe(estimateTokens(build.prompt));
    expect(build.blocks[0].tokens).toBeLessThan(1000);
    const info = getSystemPromptInfo(host);
    expect(info.tokenCount).toBe(estimateTokens(info.text));
    expect(info.tokenCount).toBeLessThan(1000);
  });
});
