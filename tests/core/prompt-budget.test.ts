import { describe, expect, it } from "vitest";
import { resolveSystemBudget } from "../../src/core/prompt-budget";

describe("single system budget ruler", () => {
  it("computes the same budget from contextWindow and systemPrompt share", () => {
    expect(resolveSystemBudget({ contextWindow: 32768, contextBudget: { systemPrompt: 0.1 } })).toBe(
      3276,
    );
    expect(resolveSystemBudget({ contextWindow: 131072, contextBudget: { systemPrompt: 0.1 } })).toBe(
      13107,
    );
  });
});
