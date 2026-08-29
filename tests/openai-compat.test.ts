import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatProvider } from "../src/llm/openai-compat";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAICompatProvider", () => {
  it("should construct with config", () => {
    const provider = new OpenAICompatProvider({
      model: "qwen/qwen3.5-9b",
      baseUrl: "http://localhost:1234/v1",
    });
    expect(provider.model).toBe("qwen/qwen3.5-9b");
    expect(provider.contextWindow).toBe(32768);
  });

  it("should respect contextWindow option", () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      contextWindow: 64000,
    });
    expect(provider.contextWindow).toBe(64000);
  });

  it("should stream text chunks", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
    });

    const mockFetch = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      body: stream,
      headers: new Map(),
    });
    global.fetch = mockFetch as any;

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text" && chunk.content) chunks.push(chunk.content);
    }
    expect(chunks.join("")).toBe("Hello world");
  });

  it("should parse tool_calls from stream", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
    });

    const mockFetch = vi.fn();
    const encoder = new TextEncoder();
    const toolCallDelta = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "read_file", arguments: '{"path":"test.txt"}' },
              },
            ],
          },
        },
      ],
    };
    const doneLine = {
      choices: [
        {
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolCallDelta)}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneLine)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      body: stream,
      headers: new Map(),
    });
    global.fetch = mockFetch as any;

    let toolCall: any = null;
    for await (const chunk of provider.chat([{ role: "user", content: "read file" }])) {
      if (chunk.type === "tool_call") toolCall = chunk.toolCall;
    }
    expect(toolCall).not.toBeNull();
    expect(toolCall!.name).toBe("read_file");
  });

  it("should wrap tools in OpenAI function format", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
    });

    let requestBody: any = null;
    const mockFetch = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        body: stream,
        headers: new Map(),
      });
    });
    global.fetch = mockFetch as any;

    const tools = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "write_file",
        description: "Write a file",
        parameters: { type: "object", properties: {} },
      },
    ];

    for await (const _ of provider.chat([{ role: "user", content: "hi" }], tools)) {
    }

    expect(requestBody).not.toBeNull();
    expect(requestBody.tools).toHaveLength(2);
    expect(requestBody.tools[0]).toEqual({
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    });
    expect(requestBody.tools[1].type).toBe("function");
    expect(requestBody.tools[1].function.name).toBe("write_file");
  });

  it("should not include tools in body when tools is empty", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
    });

    let requestBody: any = null;
    const mockFetch = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        body: stream,
        headers: new Map(),
      });
    });
    global.fetch = mockFetch as any;

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }

    expect(requestBody.tools).toBeUndefined();
  });

  it("should wait for a rate-limit slot instead of failing the turn", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      rateLimits: { maxRequestsPerMinute: 1 },
    });

    // Exhaust the limiter with a request that will expire within the wait window.
    (provider as any).rateLimiter.state.requests = [Date.now() - 45_000];
    // Simulate the passage of time: once the wait resolves, the old request
    // has aged out of the window and a slot is free again.
    const sleepSpy = vi
      .spyOn(provider as any, "sleep")
      .mockImplementation(async () => {
        (provider as any).rateLimiter.state.requests = [];
      });

    const encoder = new TextEncoder();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    });
    global.fetch = mockFetch as any;

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text" && chunk.content) chunks.push(chunk.content);
    }

    // It waited for the slot (bounded) and still made the request.
    expect(sleepSpy).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(chunks.join("")).toBe("ok");
    sleepSpy.mockRestore();
  });

  it("marks the rate-limit error recoverable when no slot frees within the wait", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      rateLimits: { maxRequestsPerMinute: 1 },
    });

    // Exhaust the limiter with a FRESH request — it cannot expire within the wait.
    (provider as any).rateLimiter.state.requests = [Date.now()];
    const sleepSpy = vi.spyOn(provider as any, "sleep").mockResolvedValue(undefined);
    const mockFetch = vi.fn();
    global.fetch = mockFetch as any;

    try {
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
      }
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.recoverableLlm).toBe(true);
      expect(e.message).toContain("Rate limit");
    }
    // fetch must never have been called.
    expect(mockFetch).not.toHaveBeenCalled();
    sleepSpy.mockRestore();
  });

  it("should handle API errors", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve('{"error":"auth failed"}'),
    });
    global.fetch = mockFetch as any;

    try {
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
      }
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("401");
    }
  });

  it("should retry on 5xx errors with exponential backoff", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 2, baseDelay: 10, maxDelay: 100 },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(new Error("Internal Server Error")),
        text: () => Promise.resolve("Internal Server Error"),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: () => Promise.reject(new Error("Service Unavailable")),
        text: () => Promise.resolve("Service Unavailable"),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "test" } }] }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      });
    global.fetch = mockFetch as any;

    const chunks: any[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("text");
  });

  it("should retry on 429 rate limit", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 1, baseDelay: 10, maxDelay: 100 },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: () => Promise.reject(new Error("Rate limited")),
        text: () => Promise.resolve("Rate limited"),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "test" } }] }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      });
    global.fetch = mockFetch as any;

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("should not retry on 4xx errors except 429", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 3, baseDelay: 10, maxDelay: 100 },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve('{"error":"bad request"}'),
    });
    global.fetch = mockFetch as any;

    try {
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
      }
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("400");
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should retry on network errors", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 2, baseDelay: 10, maxDelay: 100 },
    });

    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "test" } }] }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      });
    global.fetch = mockFetch as any;

    const chunks: any[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(chunks).toHaveLength(1);
  });

  it("should throw after max retries exceeded", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 2, baseDelay: 10, maxDelay: 100 },
    });

    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    global.fetch = mockFetch as any;

    try {
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
      }
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message).toBe("Network error");
    }

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("should surface a helpful message when 429 persists after retries", async () => {
    const provider = new OpenAICompatProvider({
      model: "deepseek-v4-flash-free",
      baseUrl: "https://opencode.ai/zen/v1",
      retry: { maxRetries: 1, baseDelay: 5, maxDelay: 50 },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({}),
      json: () => Promise.reject(new Error("Rate limited")),
      text: () => Promise.resolve("Rate limited"),
    });
    global.fetch = mockFetch as any;

    try {
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
      }
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("429");
      expect(e.message).toContain("deepseek-v4-flash-free");
      expect(e.message).toContain("API key");
    }
  });

  it("should respect Retry-After when retrying 429", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 1, baseDelay: 5, maxDelay: 50 },
    });

    const spy = vi.spyOn(provider as any, "sleep").mockResolvedValue(undefined);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "retry-after": "2" }),
        json: () => Promise.reject(new Error("Rate limited")),
        text: () => Promise.resolve("Rate limited"),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "test" } }] }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      });
    global.fetch = mockFetch as any;

    for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
    }

    // Retry-After: 2s → capped at maxDelay 50ms (+ jitter)
    expect(spy).toHaveBeenCalledTimes(1);
    const [delay] = spy.mock.calls[0];
    expect(delay).toBeGreaterThanOrEqual(50);
    expect(delay).toBeLessThan(52);
    spy.mockRestore();
  });

  it("should retry a stream that breaks before any content is delivered", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 1, baseDelay: 5, maxDelay: 50, maxStreamRetries: 2 },
    });

    const encoder = new TextEncoder();
    const mockFetch = vi
      .fn()
      .mockImplementationOnce((_url: string, _init: RequestInit) =>
        Promise.resolve({
          ok: true,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              setTimeout(() => controller.error(new Error("connection terminated")), 10);
            },
          }),
        }),
      )
      .mockImplementation((_url: string, _init: RequestInit) =>
        Promise.resolve({
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
        }),
      );
    global.fetch = mockFetch as any;

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text" && chunk.content) chunks.push(chunk.content);
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(chunks.join("")).toBe("ok");
  });

  it("should NOT retry a stream that breaks after content was already delivered", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 1, baseDelay: 5, maxDelay: 50, maxStreamRetries: 3 },
    });

    const encoder = new TextEncoder();
    const mockFetch = vi.fn().mockImplementation((_url: string, _init: RequestInit) =>
      Promise.resolve({
        ok: true,
        headers: new Map(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
            );
            setTimeout(() => controller.error(new Error("connection terminated")), 10);
          },
        }),
      }),
    );
    global.fetch = mockFetch as any;

    try {
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
      }
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("connection terminated");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should retry when the stream is idle (no data) before any content", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: {
        maxRetries: 1,
        baseDelay: 5,
        maxDelay: 50,
        maxStreamRetries: 1,
        noDataTimeoutMs: 25,
      },
    });

    const encoder = new TextEncoder();
    let firstSignal: AbortSignal | undefined;
    const mockFetch = vi
      .fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        firstSignal = init.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              firstSignal!.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
            pull() {
              return new Promise(() => {});
            },
          }),
        });
      })
      .mockImplementation((_url: string, _init: RequestInit) =>
        Promise.resolve({
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
        }),
      );
    global.fetch = mockFetch as any;

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text" && chunk.content) chunks.push(chunk.content);
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(chunks.join("")).toBe("ok");
  });

  it("should enrich the idle-timeout error when a tool_call has started", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: {
        maxRetries: 1,
        baseDelay: 5,
        maxDelay: 50,
        maxStreamRetries: 0,
        noDataTimeoutMs: 25,
      },
    });

    const encoder = new TextEncoder();
    let firstSignal: AbortSignal | undefined;
    const mockFetch = vi
      .fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        firstSignal = init.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              // First packet: tool_call starts, then silence forever (buffered provider).
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"write_file","arguments":""}}]}}]}\n\n',
                ),
              );
              firstSignal!.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
            pull() {
              return new Promise(() => {});
            },
          }),
        });
      })
      .mockImplementation((_url: string, _init: RequestInit) =>
        Promise.resolve({
          ok: true,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
        }),
      );
    global.fetch = mockFetch as any;

    try {
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
      }
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("tool_call");
      expect(e.message).toContain("retry.noDataTimeoutMs");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should throw an actionable error when a tool_call is cut off by the length limit", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 1, baseDelay: 5, maxDelay: 50, maxStreamRetries: 2 },
    });

    const encoder = new TextEncoder();
    const mockFetch = vi.fn().mockImplementation((_url: string, _init: RequestInit) =>
      Promise.resolve({
        ok: true,
        headers: new Map(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"story.md\\",\\"content\\":\\"long st"}}]}}]}\n\n',
              ),
            );
            // Length limit hit mid-arguments — no finish_reason "tool_calls".
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      }),
    );
    global.fetch = mockFetch as any;

    try {
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
      }
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("tool_call");
      expect(e.message).toContain("maxCompletionTokens");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1); // llmTerminal — no blind retries
  });

  it("should throw an actionable error when the response is empty and length-capped", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 1, baseDelay: 5, maxDelay: 50, maxStreamRetries: 2 },
    });

    const encoder = new TextEncoder();
    const mockFetch = vi.fn().mockImplementation((_url: string, _init: RequestInit) =>
      Promise.resolve({
        ok: true,
        headers: new Map(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      }),
    );
    global.fetch = mockFetch as any;

    try {
      for await (const _ of provider.chat([{ role: "user", content: "hi" }])) {
      }
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("maxCompletionTokens");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should retry a stream that closes before [DONE] with zero content", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 1, baseDelay: 5, maxDelay: 50, maxStreamRetries: 2 },
    });

    const encoder = new TextEncoder();
    const mockFetch = vi
      .fn()
      .mockImplementationOnce((_url: string, _init: RequestInit) =>
        Promise.resolve({
          ok: true,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        }),
      )
      .mockImplementation((_url: string, _init: RequestInit) =>
        Promise.resolve({
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
        }),
      );
    global.fetch = mockFetch as any;

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text" && chunk.content) chunks.push(chunk.content);
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(chunks.join("")).toBe("ok");
  });

  it("should NOT retry when the caller aborts mid-stream", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 1, baseDelay: 5, maxDelay: 50, maxStreamRetries: 3 },
    });

    const encoder = new TextEncoder();
    let capturedSignal: AbortSignal | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        headers: new Map(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
            );
            capturedSignal!.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
          pull() {
            return new Promise(() => {});
          },
        }),
      });
    });
    global.fetch = mockFetch as any;

    const ac = new AbortController();
    const consumer = (async () => {
      const chunks: string[] = [];
      for await (const chunk of provider.chat([{ role: "user", content: "hi" }], undefined, ac.signal)) {
        if (chunk.type === "text" && chunk.content) chunks.push(chunk.content);
      }
      return chunks;
    })();

    await new Promise((r) => setTimeout(r, 20));
    ac.abort();

    try {
      await consumer;
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e?.name).toBe("AbortError");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should parse NDJSON lines without the 'data: ' prefix (Ollama-style streams)", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:11434/v1",
    });

    const mockFetch = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"choices":[{"delta":{"content":"Hi"}}]}\n'));
        controller.enqueue(encoder.encode('{"choices":[{"delta":{"content":" there"}}]}\n'));
        controller.enqueue(encoder.encode('{"choices":[{"delta":{},"finish_reason":"stop"}]}\n'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, body: stream, headers: new Map() });
    global.fetch = mockFetch as any;

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text" && chunk.content) chunks.push(chunk.content);
    }
    expect(chunks.join("")).toBe("Hi there");
  });

  it("should surface a mid-stream error object instead of returning an empty response", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:11434/v1",
    });

    const mockFetch = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        controller.enqueue(encoder.encode('{"error":"an error was encountered while running the model"}\n'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, body: stream, headers: new Map() });
    global.fetch = mockFetch as any;

    let gotText = "";
    const consume = async () => {
      for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
        if (chunk.type === "text" && chunk.content) gotText += chunk.content;
      }
    };
    await expect(consume()).rejects.toThrow(/error was encountered/);
    // Content delivered before the error is not lost.
    expect(gotText).toBe("partial");
  });

  it("should treat delta.reasoning as reasoning content (Ollama alias)", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:11434/v1",
    });

    const mockFetch = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, body: stream, headers: new Map() });
    global.fetch = mockFetch as any;

    let reasoning = "";
    let text = "";
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "reasoning") reasoning += chunk.content;
      if (chunk.type === "text") text += chunk.content;
    }
    expect(reasoning).toBe("thinking...");
    expect(text).toBe("answer");
  });

  it("should NOT fall back to non-streaming when the stream delivered only reasoning", async () => {
    const provider = new OpenAICompatProvider({
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
      retry: { maxRetries: 1, baseDelay: 5, maxDelay: 50 },
    });

    const mockFetch = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"reasoning_content":"thinking about it"}}]}\n\n',
          ),
        );
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, body: stream, headers: new Map() });
    global.fetch = mockFetch as any;

    let reasoning = "";
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "reasoning") reasoning += chunk.content;
    }
    // Exactly ONE request — the reasoning-only stream is content; the
    // non-streaming fallback would emit a full duplicate answer.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(reasoning).toBe("thinking about it");
  });
});
