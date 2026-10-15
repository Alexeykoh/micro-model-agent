import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n/index";

// Локаль — процессный синглтон: порядок файлов в раннере зависит от ФС
// (на CI иной), поэтому файлы с английскими строками пинят "en" сами.
beforeEach(() => setLocale("en"));
import { webSearchTool, performWebSearch } from "../../src/tools/web-search";

describe("webSearchTool", () => {
  it("has correct definition", () => {
    expect(webSearchTool.name).toBe("web_search");
    expect(webSearchTool.description).toBeTruthy();
    expect(webSearchTool.parameters.required).toContain("query");
  });

  it("rejects calls when the web search master switch is off", async () => {
    const ctx: any = { config: { webSearch: { enabled: false } }, sessionContext: undefined };
    const result = await webSearchTool.handler(ctx, { query: "test" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("disabled");
  });

  it("allows calls when the master switch is absent (default on)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ text: async () => "<html></html>" })) as any;
    try {
      const ctx: any = { config: {}, sessionContext: undefined };
      const result = await webSearchTool.handler(ctx, { query: "test" });
      expect(result.success).toBe(true); // empty HTML → no results, still a successful call
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("performWebSearch", () => {
  it("returns a blocked outcome when the domain is denied", async () => {
    const networkConfig = {
      enabled: true,
      deniedDomains: ["html.duckduckgo.com"],
      allowedDomains: [],
      requestTimeout: 1000,
      maxResponseSize: 100000,
    };
    const outcome = await performWebSearch("test", 5, networkConfig);
    expect(outcome.success).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.results).toEqual([]);
  });

  it("returns empty results for empty HTML", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ text: async () => "<html></html>" })) as any;
    try {
      const outcome = await performWebSearch("nothing", 5, undefined);
      expect(outcome.success).toBe(true);
      expect(outcome.results).toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
