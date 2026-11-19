import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchProviderBudget, type BudgetOptions } from "../src/llm/provider-budget";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Опции вызова с логгером, который ничего не печатает. */
function opts(over: Partial<BudgetOptions> = {}): BudgetOptions {
  return { log: () => {}, ...over };
}

/** Мок: /key отдаёт `key`, /credits — `credits` (или 403 при undefined). */
function mockApi(key: unknown, credits?: unknown): ReturnType<typeof vi.fn> {
  const mockFetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/credits")) {
      if (credits === undefined) {
        return Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve("nope") });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: credits }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: key }) });
  });
  globalThis.fetch = mockFetch as any;
  return mockFetch;
}

describe("fetchProviderBudget", () => {
  it("returns unsupported for non-OpenRouter providers without a request", async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;
    const r = await fetchProviderBudget(
      "opencode-go",
      "https://opencode.ai/zen/go/v1",
      "sk-x",
      opts(),
    );
    expect(r.reason).toBe("unsupported");
    expect(r.budget).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns no-key when the api key is missing", async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;
    const r = await fetchProviderBudget(
      "openrouter",
      "https://openrouter.ai/api/v1",
      undefined,
      opts(),
    );
    expect(r.reason).toBe("no-key");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("parses per-key usage and limit", async () => {
    mockApi({ label: "my-key", usage: 12.5, limit: 50, limit_remaining: 37.5, is_free_tier: false });
    const r = await fetchProviderBudget(
      "openrouter",
      "https://openrouter.ai/api/v1",
      "sk-x",
      opts(),
    );
    expect(r.reason).toBe("ok");
    expect(r.budget?.keyUsageUsd).toBe(12.5);
    expect(r.budget?.keyLimitUsd).toBe(50);
    expect(r.budget?.keyRemainingUsd).toBe(37.5);
    expect(r.budget?.keyLabel).toBe("my-key");
  });

  it("adds account balance from /credits when the key allows it", async () => {
    mockApi({ usage: 1 }, { total_credits: 100.5, total_usage: 25.75 });
    const r = await fetchProviderBudget(
      "openrouter",
      "https://openrouter.ai/api/v1",
      "sk-x",
      opts(),
    );
    expect(r.budget?.totalCreditsUsd).toBe(100.5);
    expect(r.budget?.balanceUsd).toBeCloseTo(74.75, 6);
  });

  it("still returns key data when /credits is forbidden and logs the fallback", async () => {
    mockApi({ usage: 1 });
    const log = vi.fn();
    const r = await fetchProviderBudget(
      "openrouter",
      "https://openrouter.ai/api/v1",
      "sk-x",
      opts({ log }),
    );
    expect(r.reason).toBe("ok");
    expect(r.budget?.keyUsageUsd).toBe(1);
    expect(r.budget?.totalCreditsUsd).toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("reports an error instead of throwing on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;
    const log = vi.fn();
    const r = await fetchProviderBudget(
      "openrouter",
      "https://openrouter.ai/api/v1",
      "sk-x",
      opts({ log }),
    );
    expect(r.reason).toBe("error");
    expect(r.error).toContain("ECONNREFUSED");
    expect(log).toHaveBeenCalled();
  });

  it("reports an error on an HTTP failure of /key", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") }) as any;
    const r = await fetchProviderBudget(
      "openrouter",
      "https://openrouter.ai/api/v1",
      "sk-x",
      opts(),
    );
    expect(r.reason).toBe("error");
    expect(r.error).toContain("401");
  });
});
