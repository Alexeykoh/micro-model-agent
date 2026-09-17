import { describe, it, expect } from "vitest";
import {
  normalizeModelId,
  resolvePrice,
  calculateCost,
  calculateCostDetailed,
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

    it("bills cached tokens at the cached rate and reports savings", () => {
      // minimax-m3: input $0.30, cached read $0.06, output $1.20.
      const r = calculateCostDetailed(
        "minimax-m3",
        1_000_000,
        100_000,
        config,
        { cachedTokens: 800_000 },
      )!;
      expect(r.cost).toBeCloseTo(0.2 * 0.3 + 0.8 * 0.06 + 0.1 * 1.2, 6);
      expect(r.saved).toBeCloseTo(0.8 * (0.3 - 0.06), 6);
    });

    it("keeps the full input rate when the model has no cached price", () => {
      const r = calculateCostDetailed("gpt-5.5", 1_000_000, 0, config, {
        cachedTokens: 500_000,
      })!;
      expect(r.cost).toBeCloseTo(5, 6);
      expect(r.saved).toBe(0);
    });

    it("charges cache writes when a write rate is configured", () => {
      const cfg = {
        enabled: true,
        overrides: { custom: { input: 1, output: 2, cachedInput: 0.1, cacheWrite: 1.25 } },
      };
      const r = calculateCostDetailed("custom", 0, 0, cfg, { cacheWriteTokens: 1_000_000 })!;
      expect(r.cost).toBeCloseTo(1.25, 6);
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

    it("attributes cost per provider", () => {
      const tracker = new CostTracker("gpt-5.5", config);
      tracker.record(1_000_000, 0, "zen");
      tracker.record(1_000_000, 0, "zen");
      tracker.record(1_000_000, 0, "go");
      expect(tracker.totalFor("zen")).toBeCloseTo(10, 6);
      expect(tracker.totalFor("go")).toBeCloseTo(5, 6);
      expect(tracker.total).toBeCloseTo(15, 6);
    });

    it("records without a provider fall into 'unknown'", () => {
      const tracker = new CostTracker("gpt-5.5", config);
      tracker.record(1_000_000, 0);
      expect(tracker.totalFor("unknown")).toBeCloseTo(5, 6);
    });

    it("breakdown lists providers sorted by cost desc", () => {
      const tracker = new CostTracker("gpt-5.5", config);
      tracker.record(1_000_000, 0, "go");
      tracker.record(1_000_000, 1_000_000, "zen");
      expect(tracker.breakdown()).toEqual([
        { provider: "zen", cost: 35 },
        { provider: "go", cost: 5 },
      ]);
    });

    it("totalFor is undefined for a provider with no known price", () => {
      const tracker = new CostTracker("unknown-model", config);
      tracker.record(1000, 1000, "zen");
      expect(tracker.totalFor("zen")).toBeUndefined();
      expect(tracker.breakdown()).toEqual([]);
    });

    it("accumulates cache savings from cached usage", () => {
      const tracker = new CostTracker("minimax-m3", config);
      tracker.record(1_000_000, 0, "zen", { cachedTokens: 800_000 });
      expect(tracker.saved).toBeCloseTo(0.8 * (0.3 - 0.06), 6);
      tracker.record(1_000_000, 0, "zen", { cachedTokens: 1_000_000 });
      expect(tracker.saved).toBeCloseTo(0.192 + 0.24, 6);
    });

    it("leaves savings undefined when no price is known", () => {
      const tracker = new CostTracker("unknown-model", config);
      tracker.record(1000, 0, "zen", { cachedTokens: 500 });
      expect(tracker.saved).toBeUndefined();
    });
  });
});