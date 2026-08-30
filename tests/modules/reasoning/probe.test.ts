import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LLMProvider, Chunk } from "../../../src/llm/provider";
import {
  probeReasoningSupport,
  cacheKey,
  getCachedProbeResult,
  setCachedProbeResult,
  resetProbeCache,
} from "../../../src/modules/reasoning/probe";

function makeProvider(chunks: Chunk[] | "throw"): LLMProvider {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      if (chunks === "throw") throw new Error("network down");
      yield* chunks;
    }),
    countTokens: vi.fn().mockResolvedValue(0),
  } as unknown as LLMProvider;
}

describe("probeReasoningSupport", () => {
  beforeEach(() => {
    resetProbeCache();
  });
  afterEach(() => {
    resetProbeCache();
  });

  it("returns true when the mechanism is respected (no reasoning chunks)", async () => {
    const provider = makeProvider([{ type: "text", content: "ok" }]);
    const result = await probeReasoningSupport(provider, "low");
    expect(result).toBe(true);
  });

  it("returns false when reasoning content appears despite forced none", async () => {
    const provider = makeProvider([{ type: "reasoning", content: "thinking" }]);
    const result = await probeReasoningSupport(provider, "low");
    expect(result).toBe(false);
  });

  it("returns null on transient error instead of false", async () => {
    const provider = makeProvider("throw");
    const result = await probeReasoningSupport(provider, "low");
    expect(result).toBeNull();
  });

  it("does not cache a null probe result", async () => {
    const provider = makeProvider("throw");
    const key = cacheKey("http://x", "m");
    const passed = await probeReasoningSupport(provider, "low");
    // Simulate the bootstrap caller: only cache when a definitive result exists.
    if (passed !== null) setCachedProbeResult(key, passed);
    expect(getCachedProbeResult(key)).toBeUndefined();
  });

  it("caches a definitive result for later reads", async () => {
    const provider = makeProvider([{ type: "text", content: "ok" }]);
    const key = cacheKey("http://x", "m");
    const passed = await probeReasoningSupport(provider, "low");
    expect(passed).toBe(true);
    setCachedProbeResult(key, passed);
    expect(getCachedProbeResult(key)).toBe(true);
  });

  it("treats strategy 'none' as unsupported without probing", async () => {
    const provider = makeProvider("throw");
    expect(await probeReasoningSupport(provider, "none")).toBe(false);
  });
});