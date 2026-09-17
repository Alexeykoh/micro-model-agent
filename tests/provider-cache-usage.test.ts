import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatProvider } from "../src/llm/openai-compat";
import type { CacheCapability } from "../src/config/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function cache(over: Partial<CacheCapability>): CacheCapability {
  return {
    mechanism: "auto",
    report: "openai",
    sessionHeader: false,
    requestCachePrompt: false,
    requestPromptCacheKey: false,
    requestSessionId: false,
    requestCacheControl: false,
    requestStreamUsage: false,
    ...over,
  };
}

/** Стрим с финальным usage-чанком (пустые choices). */
function mockUsageStream(usage: unknown): void {
  const encoder = new TextEncoder();
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: new Map(),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
        );
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ usage })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  });
  globalThis.fetch = mockFetch as any;
}

async function doneUsage(provider: OpenAICompatProvider) {
  for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
    if (chunk.type === "done") return chunk.usage;
  }
  return undefined;
}

describe("cache usage parsing in openai-compat", () => {
  it("populates cache stats from OpenAI-shaped prompt_tokens_details", async () => {
    mockUsageStream({
      prompt_tokens: 1000,
      completion_tokens: 10,
      total_tokens: 1010,
      prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 50 },
    });
    const provider = new OpenAICompatProvider({
      model: "m",
      baseUrl: "http://localhost:1234/v1",
      cache: cache({}),
    });

    const usage = await doneUsage(provider);
    expect(usage?.cache).toEqual({
      cachedTokens: 900,
      cacheWriteTokens: 50,
      uncachedTokens: 100,
      source: "api",
    });
  });

  it("parses DeepSeek hit/miss fields when the report format says so", async () => {
    mockUsageStream({
      prompt_tokens: 12000,
      completion_tokens: 950,
      total_tokens: 12950,
      prompt_cache_hit_tokens: 9000,
      prompt_cache_miss_tokens: 3000,
    });
    const provider = new OpenAICompatProvider({
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com/v1",
      cache: cache({ report: "deepseek" }),
    });

    const usage = await doneUsage(provider);
    expect(usage?.cache?.cachedTokens).toBe(9000);
    expect(usage?.cache?.uncachedTokens).toBe(3000);
  });

  it("leaves cache undefined when the provider reports none", async () => {
    mockUsageStream({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 });
    const provider = new OpenAICompatProvider({
      model: "m",
      baseUrl: "http://localhost:1234/v1",
      cache: cache({}),
    });

    const usage = await doneUsage(provider);
    expect(usage?.cache).toBeUndefined();
  });

  it("populates cache stats on the non-streaming path", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "ok" } }],
          usage: {
            prompt_tokens: 500,
            completion_tokens: 5,
            total_tokens: 505,
            prompt_tokens_details: { cached_tokens: 400 },
          },
        }),
    });
    globalThis.fetch = mockFetch as any;
    const provider = new OpenAICompatProvider({
      model: "m",
      baseUrl: "http://localhost:1234/v1",
      cache: cache({}),
    });

    const chunks = await (provider as any).doNonStreaming(
      [{ role: "user", content: "hi" }],
      undefined,
      undefined,
      undefined,
    );
    const done = chunks.find((c: any) => c.type === "done");
    expect(done.usage.cache?.cachedTokens).toBe(400);
    expect(done.usage.cache?.uncachedTokens).toBe(100);
  });
});
