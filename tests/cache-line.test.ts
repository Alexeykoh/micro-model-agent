import { describe, it, expect, beforeEach } from "vitest";
import { formatCacheLine, type CacheReport } from "../src/cli/cache-line";
import { setLocale } from "../src/i18n/index";

function report(over: Partial<CacheReport>): CacheReport {
  return {
    cachedTokens: 0,
    uncachedTokens: 0,
    cacheWriteTokens: 0,
    hitRate: 0,
    source: "api",
    ...over,
  };
}

beforeEach(() => setLocale("en"));

describe("formatCacheLine", () => {
  it("shows hit rate and savings when there are cache tokens and a price", () => {
    const line = formatCacheLine(
      report({ cachedTokens: 900_000, uncachedTokens: 100_000, hitRate: 0.9, saved: 0.42 }),
    );
    expect(line).toContain("90%");
    expect(line).toContain("$0.42");
  });

  it("omits savings when there is no known price", () => {
    const line = formatCacheLine(
      report({ cachedTokens: 900_000, uncachedTokens: 100_000, hitRate: 0.9 }),
    );
    expect(line).toContain("90%");
    expect(line).not.toContain("saved");
  });

  it("falls back to prefix stability when the provider reports no tokens", () => {
    const line = formatCacheLine(
      report({ prefixStable: 0.9, prefixCause: "tools" }),
    );
    expect(line).toContain("90%");
    expect(line).toContain("tool set");
  });

  it("returns undefined when there is nothing to show", () => {
    expect(formatCacheLine(undefined)).toBeUndefined();
    expect(formatCacheLine(report({ prefixStable: 0.99, prefixCause: "none" }))).toBeUndefined();
  });
});
