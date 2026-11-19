import { describe, it, expect } from "vitest";
import { parseCacheUsage } from "../src/llm/cache-usage";

describe("parseCacheUsage", () => {
  describe("openai format", () => {
    it("reads cached_tokens and cache_write_tokens", () => {
      const usage = parseCacheUsage(
        {
          prompt_tokens: 10000,
          completion_tokens: 50,
          total_tokens: 10050,
          prompt_tokens_details: { cached_tokens: 9500, cache_write_tokens: 200 },
        },
        "openai",
      );
      expect(usage).toEqual({
        cachedTokens: 9500,
        cacheWriteTokens: 200,
        uncachedTokens: 500,
        source: "api",
      });
    });

    it("treats a zero cached_tokens with a details object as an API cache miss", () => {
      const usage = parseCacheUsage(
        { prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 0 } },
        "openai",
      );
      expect(usage?.cachedTokens).toBe(0);
      expect(usage?.uncachedTokens).toBe(2000);
      expect(usage?.source).toBe("api");
    });

    it("returns undefined when the provider reports no cache details", () => {
      expect(parseCacheUsage({ prompt_tokens: 2000 }, "openai")).toBeUndefined();
    });
  });

  describe("deepseek format", () => {
    it("maps hit/miss tokens", () => {
      const usage = parseCacheUsage(
        {
          prompt_tokens: 12000,
          prompt_cache_hit_tokens: 9000,
          prompt_cache_miss_tokens: 3000,
          completion_tokens: 950,
        },
        "deepseek",
      );
      expect(usage).toEqual({
        cachedTokens: 9000,
        cacheWriteTokens: 0,
        uncachedTokens: 3000,
        source: "api",
      });
    });

    it("returns undefined without the deepseek cache fields", () => {
      expect(parseCacheUsage({ prompt_tokens: 100 }, "deepseek")).toBeUndefined();
    });
  });

  describe("anthropic format", () => {
    it("maps cache_read/cache_creation/input tokens", () => {
      const usage = parseCacheUsage(
        {
          input_tokens: 127,
          output_tokens: 103,
          cache_read_input_tokens: 2727,
          cache_creation_input_tokens: 0,
        },
        "anthropic",
      );
      expect(usage).toEqual({
        cachedTokens: 2727,
        cacheWriteTokens: 0,
        uncachedTokens: 127,
        source: "api",
      });
    });

    it("returns undefined when no cache fields are present", () => {
      expect(parseCacheUsage({ input_tokens: 10, output_tokens: 5 }, "anthropic")).toBeUndefined();
    });
  });

  describe("ollama format (derived)", () => {
    it("derives cached tokens from the estimated prompt size", () => {
      const usage = parseCacheUsage(
        { prompt_eval_count: 120 },
        "ollama",
        1000,
      );
      expect(usage).toEqual({
        cachedTokens: 880,
        cacheWriteTokens: 0,
        uncachedTokens: 120,
        source: "derived",
      });
    });

    it("returns undefined without an estimate", () => {
      expect(parseCacheUsage({ prompt_eval_count: 120 }, "ollama")).toBeUndefined();
    });
  });

  it("returns undefined for format 'none' and for garbage input", () => {
    expect(parseCacheUsage({ prompt_tokens: 1 }, "none")).toBeUndefined();
    expect(parseCacheUsage(null, "openai")).toBeUndefined();
    expect(parseCacheUsage("nonsense", "openai")).toBeUndefined();
  });
});
