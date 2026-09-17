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

interface Capture {
  body?: any;
  headers?: Record<string, string>;
}

/** Подменяет fetch успешным SSE-стримом и записывает тело/заголовки запроса. */
function mockStream(capture: Capture): void {
  const encoder = new TextEncoder();
  const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    capture.body = JSON.parse(init.body as string);
    capture.headers = init.headers as Record<string, string>;
    return Promise.resolve({
      ok: true,
      headers: new Map(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    });
  });
  globalThis.fetch = mockFetch as any;
}

function makeProvider(cacheCap: CacheCapability, sessionId?: string) {
  return new OpenAICompatProvider({
    model: "test-model",
    baseUrl: "http://localhost:1234/v1",
    cache: cacheCap,
    getSessionId: sessionId ? () => sessionId : undefined,
  });
}

describe("cache request hints", () => {
  it("adds cache_prompt only when requestCachePrompt is on (llama.cpp)", async () => {
    const capture: Capture = {};
    mockStream(capture);
    const provider = makeProvider(cache({ requestCachePrompt: true }), "ses_1");

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.body.cache_prompt).toBe(true);
  });

  it("omits cache_prompt by default", async () => {
    const capture: Capture = {};
    mockStream(capture);
    const provider = makeProvider(cache({}), "ses_1");

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.body.cache_prompt).toBeUndefined();
  });

  it("sends prompt_cache_key when requestPromptCacheKey is on (OpenAI)", async () => {
    const capture: Capture = {};
    mockStream(capture);
    const provider = makeProvider(cache({ requestPromptCacheKey: true }), "ses_abc");

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.body.prompt_cache_key).toBe("ses_abc");
  });

  it("omits prompt_cache_key when no session id is available", async () => {
    const capture: Capture = {};
    mockStream(capture);
    const provider = makeProvider(cache({ requestPromptCacheKey: true }));

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.body.prompt_cache_key).toBeUndefined();
  });

  it("sends session_id for sticky routing when requestSessionId is on (OpenRouter)", async () => {
    const capture: Capture = {};
    mockStream(capture);
    const provider = makeProvider(cache({ requestSessionId: true }), "ses_xyz");

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.body.session_id).toBe("ses_xyz");
  });

  it("requests stream usage when requestStreamUsage is on", async () => {
    const capture: Capture = {};
    mockStream(capture);
    const provider = makeProvider(cache({ requestStreamUsage: true }), "ses_1");

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.body.stream_options).toEqual({ include_usage: true });
  });

  it("omits stream_options by default", async () => {
    const capture: Capture = {};
    mockStream(capture);
    const provider = makeProvider(cache({}), "ses_1");

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.body.stream_options).toBeUndefined();
  });

  it("also applies cache hints on the non-streaming path", async () => {
    const capture: Capture = {};
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capture.body = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "ok" } }] }),
      });
    });
    globalThis.fetch = mockFetch as any;
    const provider = makeProvider(
      cache({ requestCachePrompt: true, requestPromptCacheKey: true }),
      "ses_ns",
    );

    await (provider as any).doNonStreaming(
      [{ role: "user", content: "hi" }],
      undefined,
      undefined,
      undefined,
    );
    expect(capture.body.cache_prompt).toBe(true);
    expect(capture.body.prompt_cache_key).toBe("ses_ns");
  });
});

describe("x-opencode-session gating", () => {
  it("sends the session header when sessionHeader is on (Zen/Go)", async () => {
    const capture: Capture = {};
    mockStream(capture);
    const provider = makeProvider(cache({ sessionHeader: true }), "ses_go");

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.headers?.["x-opencode-session"]).toBe("ses_go");
  });

  it("omits the session header when sessionHeader is off", async () => {
    const capture: Capture = {};
    mockStream(capture);
    const provider = makeProvider(cache({ sessionHeader: false }), "ses_go");

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.headers?.["x-opencode-session"]).toBeUndefined();
  });

  it("keeps legacy behavior (send when no cache capability) for direct construction", async () => {
    // Backward compat: callers that build the provider directly without a cache
    // capability must still get x-opencode-session (OpenCode Go requires it).
    const capture: Capture = {};
    mockStream(capture);
    const provider = new OpenAICompatProvider({
      model: "m",
      baseUrl: "https://opencode.ai/zen/go/v1",
      getSessionId: () => "ses_legacy",
    });

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }
    expect(capture.headers?.["x-opencode-session"]).toBe("ses_legacy");
  });
});
