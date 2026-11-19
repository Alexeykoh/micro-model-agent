import { describe, it, expect } from "vitest";
import { performWebSearch } from "../../src/tools/web-search";

/**
 * `web_search` не должен выдавать «пустую выдачу» вместо ошибки HTTP
 * (аудит §2.1, план `2026-10-12-harness-module-audit-fixes`, W4/Task 4.1).
 */

function mockFetch(
  responses: Array<{ status: number; statusText?: string; body?: string }>,
): { fetchImpl: typeof fetch; state: { calls: number } } {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    const r = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    return new Response(r.body ?? "", {
      status: r.status,
      statusText: r.statusText ?? "",
    });
  }) as typeof fetch;
  return { fetchImpl, state };
}

describe("web_search: статус ответа", () => {
  it("reports a rate limit as an error, not as an empty result set", async () => {
    const { fetchImpl } = mockFetch([{ status: 429, statusText: "Too Many Requests" }]);
    const r = await performWebSearch("x", 5, undefined, 1000, fetchImpl);
    expect(r.success).toBe(false);
    expect(r.error).toContain("429");
  });

  it("reports a server error as an error", async () => {
    const { fetchImpl } = mockFetch([{ status: 500, statusText: "Server Error" }]);
    const r = await performWebSearch("x", 5, undefined, 1000, fetchImpl);
    expect(r.success).toBe(false);
    expect(r.error).toContain("500");
  });

  it("retries once on 429 and succeeds", async () => {
    const { fetchImpl, state } = mockFetch([
      { status: 429, statusText: "Too Many Requests" },
      { status: 200, body: "" },
    ]);
    const r = await performWebSearch("x", 5, undefined, 1000, fetchImpl);
    expect(state.calls).toBe(2);
    expect(r.success).toBe(true);
    expect(r.results).toEqual([]);
  });

  it("keeps an empty result set for a successful response", async () => {
    const { fetchImpl } = mockFetch([{ status: 200, body: "<html></html>" }]);
    const r = await performWebSearch("x", 5, undefined, 1000, fetchImpl);
    expect(r.success).toBe(true);
    expect(r.results).toEqual([]);
  });
});
