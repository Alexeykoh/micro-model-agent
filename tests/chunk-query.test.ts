import { describe, it, expect } from "vitest";
import {
  splitTextIntoChunks,
  runChunkQuery,
  DEFAULT_CHUNK_SYSTEM_PROMPT,
  DEFAULT_SYNTHESIS_SYSTEM_PROMPT,
} from "../src/modules/context/chunk-query";
import type { Message } from "../src/llm/provider";

function mockProvider(answers: string[], delayMs = 5) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: Array<{ system: string; user: string }> = [];
  const provider = {
    chat: async function* (messages: Message[]) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      const system = messages.find((m) => m.role === "system")?.content as string;
      const user = messages.find((m) => m.role === "user")?.content as string;
      calls.push({ system, user });
      const isChunkCall = system === DEFAULT_CHUNK_SYSTEM_PROMPT;
      const isSynthCall = system === DEFAULT_SYNTHESIS_SYSTEM_PROMPT;
      let content = "";
      if (isSynthCall) content = "SYNTHESIS";
      else if (isChunkCall) content = answers.shift() || "NO_EVIDENCE";
      inFlight--;
      yield { type: "text", content };
    },
  };
  return { provider, calls, maxInFlight: () => maxInFlight, inFlight: () => inFlight };
}

describe("splitTextIntoChunks", () => {
  it("returns a single chunk for short text", () => {
    expect(splitTextIntoChunks("hello", 12000)).toEqual(["hello"]);
  });

  it("splits on newline boundaries, never mid-line", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-abcdefghij`);
    const chunks = splitTextIntoChunks(lines.join("\n"), 100);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      const first = c.split("\n")[0];
      expect(first.startsWith("line-")).toBe(true);
    }
  });

  it("throws on non-positive chunk size", () => {
    expect(() => splitTextIntoChunks("x", 0)).toThrow();
  });
});

describe("runChunkQuery", () => {
  it("bounds parallelism and returns answers + synthesis", async () => {
    const { provider, maxInFlight } = mockProvider(["A1", "A2", "A3"]);
    const text = Array.from({ length: 90 }, (_, i) => `row${i}${"-".repeat(15)}`).join("\n");
    const res = await runChunkQuery(provider as any, text, "count rows", {
      chunkChars: 200,
      maxParallel: 2,
    });
    expect(res.chunks).toBeGreaterThan(3);
    expect(res.answers).toHaveLength(res.chunks);
    expect(res.synthesis).toBe("SYNTHESIS");
    expect(maxInFlight()).toBeLessThanOrEqual(2);
    expect(res.maxParallelObserved).toBeLessThanOrEqual(2);
  });

  it("skips synthesis when synthesize=false", async () => {
    const { provider, calls } = mockProvider(["A1"]);
    const res = await runChunkQuery(provider as any, "x".repeat(250), "q", {
      chunkChars: 100,
      synthesize: false,
    });
    expect(res.synthesis).toBe("");
    expect(calls.every((c) => c.system === DEFAULT_CHUNK_SYSTEM_PROMPT)).toBe(true);
  });

  it("answers over a single chunk without a synthesis call", async () => {
    const { provider, calls } = mockProvider(["single answer"]);
    const res = await runChunkQuery(provider as any, "short text", "q", {
      chunkChars: 100,
      synthesize: false,
    });
    expect(res.chunks).toBe(1);
    expect(res.answers[0]).toBe("single answer");
    expect(calls).toHaveLength(1);
  });
});
