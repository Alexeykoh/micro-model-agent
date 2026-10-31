import { describe, it, expect } from "vitest";
import { filterBlocksForTags } from "../../src/core/prompt-builder";
import { BrowserModule } from "../../src/modules/browser/module";
import type { PromptBlock } from "../../src/core/types";

function block(content: string, requiresTags?: string[]): PromptBlock {
  return {
    content,
    priority: "normal",
    essential: false,
    estimatedTokens: 1,
    requiresTags,
  };
}

describe("prompt blocks: tag gating", () => {
  it("drops a block whose tag is not active", () => {
    const always = block("always");
    const browser = block("browser", ["browser"]);
    expect(filterBlocksForTags([always, browser], ["file", "code"])).toEqual([always]);
  });

  it("keeps a block when one of its tags is active", () => {
    const browser = block("browser", ["browser", "vision"]);
    expect(filterBlocksForTags([browser], ["vision"])).toEqual([browser]);
  });

  it("does not filter in legacy mode (no active tags)", () => {
    const browser = block("browser", ["browser"]);
    expect(filterBlocksForTags([browser], undefined)).toEqual([browser]);
    expect(filterBlocksForTags([browser], [])).toEqual([browser]);
  });

  it("marks the browser prompt block as browser-only", () => {
    const b = new BrowserModule().getSystemPromptBlock();
    expect(b).not.toBeNull();
    expect(b!.requiresTags).toEqual(["browser"]);
  });
});
