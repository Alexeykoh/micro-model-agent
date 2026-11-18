import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n/index";

// Локаль — процессный синглтон: пиним английские сообщения явно.
beforeEach(() => setLocale("en"));

import { performWebSearch, webSearchTool } from "../../src/tools/web-search";
import { planSearchRequest } from "../../src/tools/search-providers";
import type { NetworkSecurityConfig } from "../../src/config/types";
import type { ToolContext } from "../../src/tools/types";

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(responder: (url: string, init?: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DENIED_TAVILY: NetworkSecurityConfig = {
  enabled: true,
  deniedDomains: ["api.tavily.com"],
  allowedDomains: [],
  requestTimeout: 1000,
  maxResponseSize: 100000,
};

describe("web search providers: Tavily", () => {
  it("sends the key as a Bearer header and maps API results", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        results: [
          { title: "First", url: "https://example.com/1", content: "one" },
          { title: "Second", url: "https://example.com/2", content: "two" },
          { title: "Overflow", url: "https://example.com/3", content: "three" },
        ],
      }),
    );
    const r = await performWebSearch("bun test", 2, undefined, 1000, fetchImpl, {
      provider: "tavily",
      apiKey: "tvly-secret",
    });
    expect(r.success).toBe(true);
    expect(r.url).toBe("https://api.tavily.com/search");
    expect(r.results).toEqual([
      { title: "First", url: "https://example.com/1", snippet: "one" },
      { title: "Second", url: "https://example.com/2", snippet: "two" },
    ]);
    expect(calls).toHaveLength(1);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tvly-secret");
    // Ключ не утекает в URL или query.
    expect(calls[0].url).not.toContain("tvly-secret");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      query: "bun test",
      max_results: 2,
      search_depth: "basic",
    });
  });

  it("refuses to call the network without an API key", async () => {
    const { fetchImpl, calls } = mockFetch(() => {
      throw new Error("network must not be called");
    });
    const r = await performWebSearch("q", 5, undefined, 1000, fetchImpl, {
      provider: "tavily",
    });
    expect(r.success).toBe(false);
    expect(r.url).toBeUndefined();
    expect(r.error).toContain("API key");
    expect(calls).toHaveLength(0);
  });

  it("reports an unreadable body as an error, not as an empty result set", async () => {
    const { fetchImpl } = mockFetch(() => new Response("not json", { status: 200 }));
    const r = await performWebSearch("q", 5, undefined, 1000, fetchImpl, {
      provider: "tavily",
      apiKey: "k",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("unreadable");
  });

  it("is blocked by the network policy before any request", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse({ results: [] }));
    const r = await performWebSearch("q", 5, DENIED_TAVILY, 1000, fetchImpl, {
      provider: "tavily",
      apiKey: "k",
    });
    expect(r.success).toBe(false);
    expect(r.blocked).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("web search providers: SearXNG", () => {
  it("queries the configured instance with format=json", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({ results: [{ title: "Doc", url: "https://docs.example/x", content: "body" }] }),
    );
    const r = await performWebSearch("ts 5.9", 1, undefined, 1000, fetchImpl, {
      provider: "searxng",
      baseUrl: "https://searx.example.org/",
    });
    expect(r.success).toBe(true);
    expect(r.results).toEqual([
      { title: "Doc", url: "https://docs.example/x", snippet: "body" },
    ]);
    expect(calls[0].url).toBe(
      "https://searx.example.org/search?q=ts%205.9&format=json",
    );
  });

  it("refuses a missing or non-http base URL", async () => {
    for (const baseUrl of [undefined, "", "ftp://searx.example.org", "not a url"]) {
      const { fetchImpl, calls } = mockFetch(() => {
        throw new Error("network must not be called");
      });
      const r = await performWebSearch("q", 5, undefined, 1000, fetchImpl, {
        provider: "searxng",
        baseUrl,
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain("http(s)");
      expect(calls).toHaveLength(0);
    }
  });
});

describe("web search providers: DuckDuckGo stays the default", () => {
  it("uses the DDG HTML endpoint when no provider is configured", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response("<html></html>", { status: 200 }));
    const r = await performWebSearch("q", 5, undefined, 1000, fetchImpl, {});
    expect(r.success).toBe(true);
    expect(calls[0].url).toContain("html.duckduckgo.com");
  });

  it("falls back to DDG for an unknown provider value from an old config", () => {
    const plan = planSearchRequest({ provider: "google" }, "q", 5);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.url).toContain("html.duckduckgo.com");
  });
});

describe("web_search tool: provider comes from config", () => {
  it("uses the configured provider and API key", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({ results: [{ title: "T", url: "https://example.com/t", content: "s" }] }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const ctx = {
        config: { webSearch: { enabled: true, provider: "tavily", apiKey: "k" } },
        sessionContext: undefined,
      } as unknown as ToolContext;
      const result = await webSearchTool.handler(ctx, { query: "q" });
      expect(result.success).toBe(true);
      expect(calls[0].url).toBe("https://api.tavily.com/search");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("reports a provider config error without touching the network", async () => {
    const { fetchImpl, calls } = mockFetch(() => {
      throw new Error("network must not be called");
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const ctx = {
        config: { webSearch: { enabled: true, provider: "searxng" } },
        sessionContext: undefined,
      } as unknown as ToolContext;
      const result = await webSearchTool.handler(ctx, { query: "q" });
      expect(result.success).toBe(false);
      expect(String(result.output)).toContain("http(s)");
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
