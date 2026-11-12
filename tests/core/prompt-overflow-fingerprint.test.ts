import { describe, it, expect } from "bun:test";
import { buildSystemPrompt } from "../../src/core/agent/prompt-phase";
import type { PromptBlock } from "../../src/core/types";

function kindBlock(content: string): PromptBlock {
  return {
    source: "agents-md",
    label: "instructions",
    content,
    priority: "high",
    essential: false,
    estimatedTokens: Math.ceil(content.length / 4),
    kind: "instructions",
  };
}

function hostWith(window: number, instructions: string, overrides = new Map()) {
  return {
    deps: {
      config: { model: "m", contextWindow: window, contextBudget: { systemPrompt: 0.1 } },
      promptBlocks: [kindBlock(instructions)],
      getDynamicPromptBlocks: () => [],
      pluginManager: { runOnBuildPrompt: () => [] },
      toolExecutor: { getToolDefinitions: () => [], getVisibleTags: () => new Set<string>() },
      toolTags: [],
    },
    promptProfile: "full",
    promptOverrides: overrides,
    overflowHintBlock: null,
    frozenMapBlock: null,
  } as never;
}

describe("overflow fingerprint (B16/B17)", () => {
  it("is stable across identical builds", () => {
    const a = buildSystemPrompt(hostWith(10000, "RULES v1"));
    const b = buildSystemPrompt(hostWith(10000, "RULES v1"));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("changes when instructions are edited (B16)", () => {
    const a = buildSystemPrompt(hostWith(10000, "RULES v1"));
    const b = buildSystemPrompt(hostWith(10000, "RULES v1 + new rule"));
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("changes when the system budget shrinks (B17)", () => {
    const a = buildSystemPrompt(hostWith(10000, "RULES v1"));
    const b = buildSystemPrompt(hostWith(4000, "RULES v1"));
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("ignores resolve replacements (pre-override inputs only)", () => {
    const plain = buildSystemPrompt(hostWith(10000, "RULES v1"));
    const replaced = buildSystemPrompt(
      hostWith(10000, "RULES v1", new Map([["instructions", kindBlock("SUMMARY")]])),
    );
    expect(plain.fingerprint).toBe(replaced.fingerprint);
  });
});
