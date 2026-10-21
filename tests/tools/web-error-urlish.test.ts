import { describe, it, expect } from "vitest";
import { performWebFetch } from "../../src/tools/web-fetch";

/**
 * Ошибки web-тулов называют URL и несут машиночитаемый код; `web_fetch`
 * держит документированный кап в 5000 символов (аудит §2.11/§2.12,
 * план `2026-10-12-harness-module-audit-fixes`, W4/Task 4.3b).
 */

function mockFetch(status: number, body: string, contentType = "text/html"): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": contentType },
    })) as typeof fetch;
}

describe("web_fetch: ошибки и кап", () => {
  it("names the URL so the model knows which request failed", async () => {
    const r = await performWebFetch("https://x/a", { fetchImpl: mockFetch(404, "") });
    expect(r.success).toBe(false);
    expect(r.output).toContain("https://x/a");
  });

  it("carries a machine-readable code", async () => {
    const r = await performWebFetch("https://x/a", { fetchImpl: mockFetch(404, "") });
    expect(r.errorMeta).toMatchObject({ code: "http_404", retryable: false });
  });

  it("marks 5xx as retryable", async () => {
    const r = await performWebFetch("https://x/a", { fetchImpl: mockFetch(503, "") });
    expect(r.errorMeta).toMatchObject({ code: "http_503", retryable: true });
  });

  it("honours its documented 5000-char cap", async () => {
    const body = "<body>" + "a".repeat(50_000) + "</body>";
    const r = await performWebFetch("https://x", { fetchImpl: mockFetch(200, body) });
    expect(r.success).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(5_100);
  });
});
