import { describe, it, expect } from "vitest";
import { FallbackProvider, type FallbackSource } from "../src/modules/providers/fallback";
import type { LLMProvider, } from "../src/llm/provider";
import { LlmError } from "../src/llm/llm-errors";

function makeProvider(_name: string, behavior: () => AsyncIterable<any> | never): LLMProvider {
  return {
    model: "m",
    contextWindow: 1000,
    chat: async function* () {
      yield* (behavior as any)();
    },
    countTokens: () => 1,
    listModels: async () => [],
  } as unknown as LLMProvider;
}

function err(status?: number, msg = "boom"): Error {
  return new LlmError(msg, status !== undefined ? { llmStatus: status } : undefined);
}

function makeSource(order: string[], providers: Map<string, LLMProvider>): FallbackSource {
  let activeIdx = 0;
  return {
    get activeName() {
      return order[activeIdx];
    },
    listNames: () => [...order],
    switch(name: string) {
      activeIdx = order.indexOf(name);
      return providers.get(name)!;
    },
    get active() {
      return providers.get(order[activeIdx])!;
    },
  };
}

async function collect(chunks: AsyncIterable<any>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of chunks) out.push(c.type ?? String(c));
  return out;
}

describe("FallbackProvider", () => {
  it("delegates to the active provider on success", async () => {
    const a = makeProvider("a", async function* () {
      yield { type: "text", content: "ok" };
    });
    const src = makeSource(["a", "b"], new Map([["a", a]]));
    const fb = new FallbackProvider(src);
    const chunks = await collect(fb.chat([{ role: "user", content: "hi" }]));
    expect(chunks).toEqual(["text"]);
    expect(src.activeName).toBe("a");
  });

  it("fails over to the next provider on 429 and switches the source", async () => {
    const calls: string[] = [];
    const a = makeProvider("a", () => {
      calls.push("a");
      throw err(429, "rate limited");
    });
    const b = makeProvider("b", async function* () {
      calls.push("b");
      yield { type: "text", content: "from-b" };
    });
    const src = makeSource(["a", "b"], new Map([["a", a], ["b", b]]));
    const failovers: Array<[string, string]> = [];
    const fb = new FallbackProvider(src, (from, to) => failovers.push([from, to]));
    await collect(fb.chat([{ role: "user", content: "hi" }]));
    expect(calls).toEqual(["a", "b"]);
    expect(src.activeName).toBe("b");
    expect(failovers).toEqual([["a", "b"]]);
  });

  it("does not fail over on non-retryable errors (4xx)", async () => {
    const calls: string[] = [];
    const a = makeProvider("a", () => {
      calls.push("a");
      throw err(400, "bad request");
    });
    const b = makeProvider("b", async function* () {
      calls.push("b");
      yield { type: "text" };
    });
    const src = makeSource(["a", "b"], new Map([["a", a], ["b", b]]));
    const fb = new FallbackProvider(src);
    await expect(collect(fb.chat([{ role: "user", content: "hi" }]))).rejects.toThrow(
      /bad request/,
    );
    expect(calls).toEqual(["a"]);
  });

  it("rethrows after exhausting all entries", async () => {
    const a = makeProvider("a", () => {
      throw err(500, "a-down");
    });
    const b = makeProvider("b", () => {
      throw err(503, "b-down");
    });
    const src = makeSource(["a", "b"], new Map([["a", a], ["b", b]]));
    const fb = new FallbackProvider(src);
    await expect(collect(fb.chat([{ role: "user", content: "hi" }]))).rejects.toThrow(
      /b-down/,
    );
  });

  it("never fails over on caller abort", async () => {
    const a = makeProvider("a", () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const b = makeProvider("b", async function* () {
      yield { type: "text" };
    });
    const src = makeSource(["a", "b"], new Map([["a", a], ["b", b]]));
    const fb = new FallbackProvider(src);
    await expect(collect(fb.chat([{ role: "user", content: "hi" }]))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(src.activeName).toBe("a");
  });

  it("treats network errors (no llmStatus) as failover-worthy", async () => {
    const a = makeProvider("a", () => {
      throw new Error("fetch failed");
    });
    const b = makeProvider("b", async function* () {
      yield { type: "text", content: "ok" };
    });
    const src = makeSource(["a", "b"], new Map([["a", a], ["b", b]]));
    const fb = new FallbackProvider(src);
    await collect(fb.chat([{ role: "user", content: "hi" }]));
    expect(src.activeName).toBe("b");
  });

  it("fails over on Bun-style connection errors (code: ConnectionRefused)", async () => {
    const a = makeProvider("a", () => {
      throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
        code: "ConnectionRefused",
        llmTerminal: true,
      });
    });
    const b = makeProvider("b", async function* () {
      yield { type: "text", content: "ok" };
    });
    const src = makeSource(["a", "b"], new Map([["a", a], ["b", b]]));
    const fb = new FallbackProvider(src);
    await collect(fb.chat([{ role: "user", content: "hi" }]));
    expect(src.activeName).toBe("b");
  });

  it("fails over on Node-style ECONNREFUSED code", async () => {
    const a = makeProvider("a", () => {
      throw Object.assign(new Error("request failed"), { code: "ECONNREFUSED" });
    });
    const b = makeProvider("b", async function* () {
      yield { type: "text", content: "ok" };
    });
    const src = makeSource(["a", "b"], new Map([["a", a], ["b", b]]));
    const fb = new FallbackProvider(src);
    await collect(fb.chat([{ role: "user", content: "hi" }]));
    expect(src.activeName).toBe("b");
  });

  it("wraps around the entry list when failing over from the last entry", async () => {
    const b = makeProvider("b", () => {
      throw err(429, "b-limited");
    });
    const a = makeProvider("a", async function* () {
      yield { type: "text", content: "back-to-a" };
    });
    const src = makeSource(["a", "b"], new Map([["a", a], ["b", b]]));
    src.switch("b");
    const fb = new FallbackProvider(src);
    await collect(fb.chat([{ role: "user", content: "hi" }]));
    expect(src.activeName).toBe("a");
  });

  it("countTokens and listModels delegate to the active provider", async () => {
    const a = makeProvider("a", async function* () {});
    const src = makeSource(["a"], new Map([["a", a]]));
    const fb = new FallbackProvider(src);
    expect(fb.countTokens("x")).toBe(1);
    await expect(fb.listModels()).resolves.toEqual([]);
  });

  it("single-provider setup just rethrows (nothing to fail over to)", async () => {
    const a = makeProvider("a", () => {
      throw err(429, "only-one");
    });
    const src = makeSource(["a"], new Map([["a", a]]));
    const fb = new FallbackProvider(src);
    await expect(collect(fb.chat([{ role: "user", content: "hi" }]))).rejects.toThrow(
      /only-one/,
    );
  });
});
