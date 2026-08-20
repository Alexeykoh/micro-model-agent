import { describe, it, expect } from "vitest";
import {
  normalizeModelId,
  resolvePrice,
  calculateCost,
  formatCost,
} from "../src/modules/pricing/prices";
import { CostTracker } from "../src/modules/pricing/index";

describe("pricing module", () => {
  describe("normalizeModelId", () => {
    it("strips known provider prefixes", () => {
      expect(normalizeModelId("opencode/gpt-5.5")).toBe("gpt-5.5");
      expect(normalizeModelId("opencode-go/kimi-k3")).toBe("kimi-k3");
      expect(normalizeModelId("openai/gpt-5")).toBe("gpt-5");
      expect(normalizeModelId("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    });

    it("keeps bare and vendor-prefixed ids", () => {
      expect(normalizeModelId("gpt-5.5")).toBe("gpt-5.5");
      expect(normalizeModelId("qwen/qwen3.5-9b")).toBe("qwen3.5-9b");
    });
  });

  describe("resolvePrice", () => {
    const config = { enabled: true, overrides: {} };

    it("returns undefined when pricing is disabled", () => {
      expect(resolvePrice("gpt-5.5", { enabled: false, overrides: {} })).toBeUndefined();
    });

    it("returns undefined for unknown models", () => {
      expect(resolvePrice("unknown-model", config)).toBeUndefined();
    });

    it("finds builtin Zen prices", () => {
      expect(resolvePrice("opencode/gpt-5.5", config)).toEqual({ input: 5, output: 30 });
      expect(resolvePrice("opencode-go/deepseek-v4-flash", config)).toEqual({
        input: 0.22,
        output: 0.66,
      });
    });

    it("overrides win over builtin prices", () => {
      const cfg = {
        enabled: true,
        overrides: { "opencode/gpt-5.5": { input: 1, output: 2 } },
      };
      expect(resolvePrice("opencode/gpt-5.5", cfg)).toEqual({ input: 1, output: 2 });
    });
  });

  describe("calculateCost", () => {
    const config = { enabled: true, overrides: {} };

    it("computes cost from token usage", () => {
      // 1M prompt + 1M completion at gpt-5.5 ($5 / $30) = $35
      expect(calculateCost("gpt-5.5", 1_000_000, 1_000_000, config)).toBeCloseTo(35, 6);
    });

    it("returns undefined without a known price", () => {
      expect(calculateCost("unknown", 1000, 1000, config)).toBeUndefined();
    });

    it("returns zero for free models", () => {
      expect(calculateCost("big-pickle", 1_000_000, 1_000_000, config)).toBe(0);
    });
  });

  describe("formatCost", () => {
    it("formats different magnitudes", () => {
      expect(formatCost(0)).toBe("$0.00");
      expect(formatCost(1.23)).toBe("$1.23");
      expect(formatCost(0.0045)).toBe("$0.0045");
      expect(formatCost(0.0000123)).toBe("$0.000012");
    });
  });

  describe("CostTracker", () => {
    const config = { enabled: true, overrides: {} };

    it("accumulates cost and exposes total", () => {
      const tracker = new CostTracker("gpt-5.5", config);
      expect(tracker.total).toBeUndefined();
      tracker.record(1_000_000, 1_000_000);
      expect(tracker.total).toBeCloseTo(35, 6);
      tracker.record(1_000_000, 1_000_000);
      expect(tracker.total).toBeCloseTo(70, 6);
      expect(tracker.formatted).toBe("$70.00");
    });

    it("stays undefined when no price is known", () => {
      const tracker = new CostTracker("unknown-model", config);
      tracker.record(1000, 1000);
      expect(tracker.total).toBeUndefined();
      expect(tracker.formatted).toBeUndefined();
    });

    it("setModel switches the price used for later records", () => {
      const tracker = new CostTracker("gpt-5.5", config);
      tracker.record(1_000_000, 0);
      expect(tracker.total).toBeCloseTo(5, 6);
      tracker.setModel("big-pickle");
      tracker.record(1_000_000, 0);
      expect(tracker.total).toBeCloseTo(5, 6);
    });
  });
});