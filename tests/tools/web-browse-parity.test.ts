import { describe, it, expect } from "vitest";
import { performWebBrowse } from "../../src/tools/web-browse";
import { MAX_PREVIEW_LINES } from "../../src/tools/preview";

/**
 * `web_browse` — не худший двойник `web_fetch`: статус проверяется, структура
 * строк сохраняется (аудит §2.2, план `2026-10-12-harness-module-audit-fixes`,
 * W4/Task 4.2).
 */

function mockFetch(status: number, body: string, contentType = "text/html"): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": contentType },
    })) as typeof fetch;
}

describe("web_browse", () => {
  it("returns an error for HTTP 404, not the error page body as content", async () => {
    const r = await performWebBrowse("https://x/404", { fetchImpl: mockFetch(404, "Not Found") });
    expect(r.success).toBe(false);
    expect(r.output).toContain("404");
    expect(r.output).toContain("https://x/404");
  });

  it("preserves line structure and applies the line cap", async () => {
    const html =
      "<body>" +
      Array.from({ length: 100 }, (_, i) => `<p>line ${i}</p>`).join("") +
      "</body>";
    const r = await performWebBrowse("https://x/", { fetchImpl: mockFetch(200, html) });
    expect(r.success).toBe(true);
    // Рамка недоверенного контента добавляет две строки (открывающий и
    // закрывающий теги) — они не входят в лимит содержимого.
    const lines = r.output.split("\n").length;
    expect(lines).toBeLessThanOrEqual(MAX_PREVIEW_LINES + 4);
    expect(lines).toBeGreaterThan(10);
  });

  it("keeps a real page readable", async () => {
    const html = "<body><main><h1>Title</h1><p>Some content here</p></main></body>";
    const r = await performWebBrowse("https://x/", { fetchImpl: mockFetch(200, html) });
    expect(r.success).toBe(true);
    expect(r.output).toContain("Title");
  });
});
