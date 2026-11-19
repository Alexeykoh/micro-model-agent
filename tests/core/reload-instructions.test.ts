import { describe, expect, it } from "vitest";
import { replaceInstructionBlocks } from "../../src/core/agent/surface";
import type { PromptBlock } from "../../src/core/types";

function block(kind: PromptBlock["kind"], label: string): PromptBlock {
  return {
    source: "core",
    label,
    content: label,
    priority: "high",
    essential: false,
    estimatedTokens: 1,
    kind,
  };
}

describe("replaceInstructionBlocks", () => {
  it("swaps AGENTS.md blocks in place, keeping their position", () => {
    const blocks = [
      block("system", "system"),
      block("instructions", "old a"),
      block("instructions", "old b"),
      block("project-map", "map"),
    ];

    const count = replaceInstructionBlocks(blocks, [
      { ...block("instructions", "new a") },
      { ...block("instructions", "new b") },
      { ...block("instructions", "new c") },
    ]);

    expect(count).toBe(3);
    expect(blocks.map((b) => b.label)).toEqual([
      "system",
      "new a",
      "new b",
      "new c",
      "map",
    ]);
  });

  it("mutates the shared array instead of replacing it", () => {
    const blocks = [block("instructions", "old")];
    const same = blocks;
    replaceInstructionBlocks(blocks, [block("instructions", "fresh")]);
    expect(same).toBe(blocks);
    expect(blocks[0]?.label).toBe("fresh");
  });

  it("appends when there was no instruction block before", () => {
    const blocks = [block("system", "system")];
    replaceInstructionBlocks(blocks, [block("instructions", "fresh")]);
    expect(blocks.map((b) => b.label)).toEqual(["system", "fresh"]);
  });

  it("removes instructions when the fresh list is empty", () => {
    const blocks = [block("system", "system"), block("instructions", "old")];
    expect(replaceInstructionBlocks(blocks, [])).toBe(0);
    expect(blocks.map((b) => b.label)).toEqual(["system"]);
  });
});
