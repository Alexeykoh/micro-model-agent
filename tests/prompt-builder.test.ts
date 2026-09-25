import { describe, it, expect } from "vitest";
import { PromptBuilder } from "../src/core/prompt-builder";

describe("PromptBuilder", () => {
  it("should include essential blocks regardless of budget", () => {
    const builder = new PromptBuilder(100);
    builder.addBlock({
      content: "A".repeat(60),
      priority: "critical",
      essential: true,
      estimatedTokens: 60,
    });
    builder.addBlock({
      content: "B".repeat(60),
      priority: "normal",
      essential: false,
      estimatedTokens: 60,
    });
    const result = builder.build();
    expect(result.prompt).toContain("A".repeat(60));
    expect(result.prompt).not.toContain("B".repeat(60));
  });

  it("should sort by priority", () => {
    const builder = new PromptBuilder(1000);
    builder.addBlock({ content: "low", priority: "low", essential: false, estimatedTokens: 5 });
    builder.addBlock({ content: "high", priority: "high", essential: false, estimatedTokens: 5 });
    builder.addBlock({
      content: "critical",
      priority: "critical",
      essential: true,
      estimatedTokens: 5,
    });
    const result = builder.build();
    const idxCritical = result.prompt.indexOf("critical");
    const idxHigh = result.prompt.indexOf("high");
    const idxLow = result.prompt.indexOf("low");
    expect(idxCritical).toBeLessThan(idxHigh);
    expect(idxHigh).toBeLessThan(idxLow);
  });

  it("should report excluded blocks", () => {
    const builder = new PromptBuilder(50);
    builder.addBlock({
      content: "essential",
      priority: "critical",
      essential: true,
      estimatedTokens: 30,
    });
    builder.addBlock({
      content: "excluded-me",
      priority: "low",
      essential: false,
      estimatedTokens: 100,
    });
    const result = builder.build();
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]).toBe("excluded-me");
  });

  it("should fit blocks within token budget", () => {
    const builder = new PromptBuilder(50);
    builder.addBlock({ content: "A", priority: "normal", essential: false, estimatedTokens: 30 });
    builder.addBlock({ content: "B", priority: "low", essential: false, estimatedTokens: 30 });
    const result = builder.build();
    expect(result.excluded).toHaveLength(1);
  });

  it("should handle empty builder", () => {
    const builder = new PromptBuilder(100);
    const result = builder.build();
    expect(result.prompt).toBe("");
    expect(result.excluded).toEqual([]);
  });

  it("should report per-block breakdown with included/excluded flags", () => {
    const builder = new PromptBuilder(50);
    builder.addBlock({
      content: "essential block",
      priority: "critical",
      essential: true,
      estimatedTokens: 30,
    });
    builder.addBlock({
      content: "kept block",
      priority: "high",
      essential: false,
      estimatedTokens: 10,
    });
    builder.addBlock({
      content: "dropped block",
      priority: "low",
      essential: false,
      estimatedTokens: 100,
    });
    const result = builder.build();
    expect(result.blocks).toHaveLength(3);
    const byLabel = Object.fromEntries(result.blocks.map((b) => [b.label, b]));
    expect(byLabel["essential block"].included).toBe(true);
    expect(byLabel["essential block"].priority).toBe("critical");
    expect(byLabel["kept block"].included).toBe(true);
    expect(byLabel["dropped block"].included).toBe(false);
    expect(byLabel["dropped block"].tokens).toBe(100);
  });
});
