import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatProvider } from "../src/llm/openai-compat";
import type { ReasoningStrategy } from "../src/config/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Перехватывает тело запроса и отдаёт валидный минимальный SSE-стрим. */
async function captureBody(
  reasoningEffort: string | undefined,
  reasoningStrategy: ReasoningStrategy,
): Promise<Record<string, unknown>> {
  const provider = new OpenAICompatProvider({
    model: "deepseek-v4.1-flash",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });

  let body: Record<string, unknown> = {};
  const encoder = new TextEncoder();
  const frames = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"];
  globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Promise.resolve({
      ok: true,
      headers: new Map(),
      body: new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
    });
  }) as unknown as typeof fetch;

  for await (const _ of provider.chat([{ role: "user", content: "hi" }], undefined, undefined, {
    reasoningEffort,
    reasoningStrategy,
  })) {
    // consume stream
  }
  return body;
}

describe("reasoning_effort normalization", () => {
  it("clamps 'max' to 'high' for openai-effort", async () => {
    const body = await captureBody("max", "openai-effort");
    expect(body.reasoning_effort).toBe("high");
  });

  it("omits the field for 'none' (strict OpenAI rejects it)", async () => {
    const body = await captureBody("none", "openai-effort");
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("omits the field for 'default'", async () => {
    const body = await captureBody("default", "openai-effort");
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("passes valid levels through unchanged", async () => {
    expect((await captureBody("low", "openai-effort")).reasoning_effort).toBe("low");
    expect((await captureBody("medium", "openai-effort")).reasoning_effort).toBe("medium");
    expect((await captureBody("high", "openai-effort")).reasoning_effort).toBe("high");
  });

  it("never sends an invalid value on prompt-tag", async () => {
    expect((await captureBody("max", "prompt-tag")).reasoning_effort).toBe("high");
    expect((await captureBody("none", "prompt-tag")).reasoning_effort).toBeUndefined();
  });

  it("prompt-tag 'none' appends /no_think instead of the field", async () => {
    const body = await captureBody("none", "prompt-tag");
    const messages = body.messages as Array<{ content: string }>;
    expect(String(messages.at(-1)?.content)).toContain("/no_think");
  });

  it("template-kwarg toggles enable_thinking", async () => {
    const off = await captureBody("none", "template-kwarg");
    expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
    const on = await captureBody("high", "template-kwarg");
    expect(on.chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});
