/**
 * Финал стрима несёт `finishReason`: в живой сессии
 * `ses_mvzp8cuk_ntwlghmbthlcifwp` ни один `assistant` в `session.jsonl` не
 * имел `finish`, потому что `done` эмитился только при наличии `usage`, а в
 * ветке `[DONE]` (и у LM Studio без usage) его не было. Признак `length`
 * терялся вместе с ним — обрезку нельзя было отличить от полного ответа.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAICompatProvider } from "../../src/llm/openai-compat";
import type { Chunk } from "../../src/llm/provider";

const encoder = new TextEncoder();

function mockStream(lines: string[]): void {
  const mockFetch = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  mockFetch.mockResolvedValue({ ok: true, body: stream, headers: new Map() });
  global.fetch = mockFetch as unknown as typeof fetch;
}

async function collect(provider: OpenAICompatProvider): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
    chunks.push(chunk);
  }
  return chunks;
}

function makeProvider(): OpenAICompatProvider {
  return new OpenAICompatProvider({ model: "test-model", baseUrl: "http://localhost:1234/v1" });
}

describe("openai-compat: finishReason в финале стрима", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("отдаёт done.finishReason = stop", async () => {
    mockStream([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(makeProvider());
    const done = chunks.filter((c) => c.type === "done");
    expect(done.map((c) => c.finishReason)).toContain("stop");
  });

  it("отдаёт finishReason = length (обрезка видна петле)", async () => {
    mockStream([
      'data: {"choices":[{"delta":{"content":"part"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(makeProvider());
    expect(chunks.some((c) => c.finishReason === "length")).toBe(true);
  });

  it("done с usage тоже несёт finishReason", async () => {
    mockStream([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const chunks = await collect(makeProvider());
    const done = chunks.filter((c) => c.type === "done");
    expect(done.some((c) => c.usage && c.finishReason === "stop")).toBe(true);
  });
});
