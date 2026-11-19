import { describe, it, expect } from "vitest";
import { computeCacheStats } from "../../src/core/agent/cache-stats";
import { createLoopState } from "../../src/core/agent/loop-state";

describe("computeCacheStats", () => {
  it("returns undefined with neither provider tokens nor prefix monitor", () => {
    const state = createLoopState();
    expect(computeCacheStats(state, undefined)).toBeUndefined();
  });

  it("omits hitRate when only the prefix monitor ran (provider sent no cache tokens)", () => {
    const state = createLoopState();
    // Prefix-монитор заполняет stableRatio ВСЕГДА — это и давало ложный «0%».
    state.prefixDelta = {
      prevTokens: 100,
      currTokens: 120,
      commonPrefixTokens: 90,
      stableRatio: 0.75,
      cause: "none",
    };
    const stats = computeCacheStats(state, undefined);
    expect(stats).toBeDefined();
    expect(stats?.hitRate).toBeUndefined();
    expect(stats?.prefixStable).toBe(0.75);
    expect(stats?.source).toBe("none");
  });

  it("computes hitRate from provider tokens", () => {
    const state = createLoopState();
    state.cacheCachedTotal = 900;
    state.cacheUncachedTotal = 100;
    state.cacheSource = "api";
    const stats = computeCacheStats(state, 0.42);
    expect(stats?.hitRate).toBeCloseTo(0.9);
    expect(stats?.cachedTokens).toBe(900);
    expect(stats?.saved).toBe(0.42);
    expect(stats?.source).toBe("api");
  });

  it("reports 0% only when the provider explicitly returns all-uncached tokens", () => {
    const state = createLoopState();
    state.cacheCachedTotal = 0;
    state.cacheUncachedTotal = 500;
    state.cacheSource = "api";
    expect(computeCacheStats(state, undefined)?.hitRate).toBe(0);
  });
});
