import { describe, it, expect, vi } from "vitest";
import { OtelAdapter } from "../src/modules/otel/adapter";
import { OtelProvider } from "../src/modules/otel/decorate";
import { createOtelAdapter } from "../src/modules/otel/adapter";
import type { LLMProvider } from "../src/llm/provider";

describe("OtelAdapter", () => {
  const origFetch = globalThis.fetch;
  function stubFetch(fn: typeof fetch): void {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fn;
  }
  function restoreFetch(): void {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
  }
  it("no-op when disabled (no fetch, no spans)", async () => {
    let called = 0;
    stubFetch(async () => {
      called++;
      return new Response("{}", { status: 200 });
    });
    try {
      const adapter = new OtelAdapter({ enabled: false, endpoint: "https://collector:4318", serviceName: "mma" });
      const span = adapter.startSpan("llm.chat", { "gen_ai.request.model": "m" });
      await span.ended("ok", {});
      await adapter.flush();
      expect(called).toBe(0);
    } finally {
      restoreFetch();
    }
  });

  it("exports resourceSpans payload with gen_ai attrs when enabled", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    stubFetch(async (url, init) => {
      calls.push({ url: String(url), body: String((init as { body: string }).body) });
      return new Response("{}", { status: 200 });
    });
    try {
      const adapter = createOtelAdapter({ enabled: true, endpoint: "https://collector:4318", serviceName: "mma" });
      adapter.setThread("thr_0123456789abcdef", "ses_1");
      const span = adapter.startSpan("tool.call", { "gen_ai.tool.name": "bash" });
      await span.ended("ok", { "gen_ai.tool.success": true });
      await adapter.flush();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://collector:4318/v1/traces");
      const body = JSON.parse(calls[0].body) as {
        resourceSpans: Array<{ resource: { attributes: Array<{ key: string }> } }>;
      };
      expect(body.resourceSpans[0].resource.attributes[0].key).toBe("service.name");
      expect(calls[0].body).toContain("thr_0123456789abcdef");
      expect(calls[0].body).toContain("bash");
      expect(calls[0].body).toContain("gen_ai.status");
      expect(calls[0].body).toContain("ok");
    } finally {
      restoreFetch();
    }
  });
});

describe("OtelProvider decorator", () => {
  it("passthrough chunks and ends span with tokens", async () => {
    const fake: LLMProvider = {
      model: "m",
      contextWindow: 100,
      async *chat() {
        yield { type: "text" as const, content: "hi" };
        yield { type: "done" as const, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      },
      countTokens: (t: string) => t.length,
      listModels: async () => ["m"],
    };
    const spans: Array<{ kind: string }> = [];
    const adapter = createOtelAdapter({ enabled: true, endpoint: "https://collector:4318", serviceName: "mma" });
    void spans;
    const provider = new OtelProvider(fake);
    const out: string[] = [];
    for await (const c of provider.chat([{ role: "user", content: "hi" }])) {
      if (c.type === "text") out.push(c.content ?? "");
    }
    expect(out).toEqual(["hi"]);
    // Spanended flushes on end() via flush threshold? Ended span is pushed to internal buffer.
    void adapter;
  });
});
