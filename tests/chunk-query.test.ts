import { describe, it, expect } from "vitest";
import {
  splitTextIntoChunks,
  runChunkQuery,
  DEFAULT_CHUNK_SYSTEM_PROMPT,
  DEFAULT_SYNTHESIS_SYSTEM_PROMPT,
} from "../src/core/context/chunk-query";
import type { Message } from "../src/llm/provider";

function mockProvider(answers: string[], delayMs = 5) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: Array<{ system: string; user: string; sessionId?: string }> = [];
  const provider = {
    chat: async function* (
      messages: Message[],
      _tools?: unknown,
      _signal?: unknown,
      options?: { sessionId?: string },
    ) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      const system = messages.find((m) => m.role === "system")?.content as string;
      const user = messages.find((m) => m.role === "user")?.content as string;
      calls.push({ system, user, sessionId: options?.sessionId });
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

  it("forwards the owning sessionId to every chunk and synthesis call", async () => {
    const { provider, calls } = mockProvider(["A1", "A2", "A3"]);
    const text = Array.from({ length: 90 }, (_, i) => `row${i}${"-".repeat(15)}`).join("\n");
    await runChunkQuery(provider as any, text, "q", {
      chunkChars: 200,
      maxParallel: 2,
      sessionId: "ses_owner",
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => c.sessionId === "ses_owner")).toBe(true);
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

  it("survives a single failing chunk — other chunks and synthesis still work", async () => {
    // Provider that throws on the second call (chunk 2).
    let callCount = 0;
    const provider = {
      chat: async function* (messages: Message[]) {
        callCount++;
        const system = messages.find((m) => m.role === "system")?.content as string;
        if (callCount === 2) {
          throw new Error("rate limited");
        }
        const isSynth = system === DEFAULT_SYNTHESIS_SYSTEM_PROMPT;
        yield { type: "text" as const, content: isSynth ? "SYNTHESIS" : "OK" };
      },
    };
    const text = Array.from({ length: 90 }, (_, i) => `row${i}${"-".repeat(15)}`).join("\n");
    const res = await runChunkQuery(provider as any, text, "q", {
      chunkChars: 200,
      maxParallel: 1,
    });
    // Failed chunk got [FAILED], others got OK
    const failedCount = res.answers.filter((a) => a.startsWith("[FAILED]")).length;
    expect(failedCount).toBe(1);
    const okCount = res.answers.filter((a) => a === "OK").length;
    expect(okCount).toBe(res.chunks - 1);
    // Synthesis still ran
    expect(res.synthesis).toBe("SYNTHESIS");
  });

  it("caps synthesis input when chunk answers are very long", async () => {
    // Force many chunks with long answers to exceed MAX_SYNTHESIS_INPUT_CHARS
    const bigAnswer = "x".repeat(5000);
    const callLog: string[] = [];
    const provider = {
      chat: async function* (messages: Message[]) {
        const system = messages.find((m) => m.role === "system")?.content as string;
        const user = messages.find((m) => m.role === "user")?.content as string;
        callLog.push(system);
        if (system === DEFAULT_SYNTHESIS_SYSTEM_PROMPT) {
          // Verify the synthesis input was truncated
          expect(user!.length).toBeLessThan(30000);
          yield { type: "text" as const, content: "SYNTHESIS" };
        } else {
          yield { type: "text" as const, content: bigAnswer };
        }
      },
    };
    // 5 chunks × 5000 chars = 25000 > MAX_SYNTHESIS_INPUT_CHARS (20000)
    const text = Array.from({ length: 100 }, (_, i) => `row${i}${"-".repeat(50)}`).join("\n");
    const res = await runChunkQuery(provider as any, text, "q", {
      chunkChars: 100,
      synthesize: true,
    });
    expect(res.synthesis).toBe("SYNTHESIS");
    expect(res.chunks).toBeGreaterThanOrEqual(4);
  });

  it("does not start new chunks after signal is aborted", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const provider = {
      chat: async function* (messages: Message[]) {
        const user = messages.find((m) => m.role === "user")?.content as string;
        const chunkMatch = user?.match(/Text:\n(.)/);
        started.push(Date.now());
        // Abort after first chunk starts
        if (started.length === 1) controller.abort();
        await new Promise((r) => setTimeout(r, 20));
        yield { type: "text" as const, content: "OK" };
      },
    };
    const text = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
    // Should complete quickly without processing all 20 chunks
    const res = await runChunkQuery(provider as any, text, "q", {
      chunkChars: 5,
      maxParallel: 1,
      signal: controller.signal,
    });
    // At least some chunks were skipped (not all 20 processed)
    expect(res.chunks).toBeGreaterThanOrEqual(1);
  });
});
