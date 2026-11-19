import { describe, it, expect } from "vitest";
import { withTokenCap } from "../../src/llm/token-cap";
import { parseMaxTokens } from "../../src/tools/subagent-run";
import type { ChatOptions, Chunk, LLMProvider, Message } from "../../src/llm/provider";

/**
 * `max_tokens` субагента работает (аудит §2.13, план
 * `2026-10-12-harness-module-audit-fixes`, W4/Task 4.8).
 */

function spyProvider(): { provider: LLMProvider; seen: ChatOptions[] } {
  const seen: ChatOptions[] = [];
  const provider: LLMProvider = {
    model: "test-model",
    contextWindow: 32000,
    countTokens: (text) => text.length,
    listModels: async () => ["test-model"],
    chat: (_messages: Message[], _tools, _signal, options) => {
      seen.push(options ?? {});
      return (async function* (): AsyncIterable<Chunk> {
        yield { type: "done" };
      })();
    },
  };
  return { provider, seen };
}

async function drain(iter: AsyncIterable<Chunk>): Promise<void> {
  for await (const _ of iter) {
    /* пусто */
  }
}

describe("max_tokens субагента", () => {
  it("caps the completion tokens of every call", async () => {
    const { provider, seen } = spyProvider();
    const capped = withTokenCap(provider, 400);
    await drain(capped.chat([{ role: "user", content: "x" }]));
    expect(seen[0].maxTokens).toBe(400);
  });

  it("never raises a smaller limit set by the caller", async () => {
    const { provider, seen } = spyProvider();
    const capped = withTokenCap(provider, 400);
    await drain(capped.chat([{ role: "user", content: "x" }], undefined, undefined, { maxTokens: 100 }));
    expect(seen[0].maxTokens).toBe(100);
  });

  it("lets an explicit larger limit through for budget escalation", async () => {
    // Петля один раз поднимает бюджет после обрыва до ответа
    // (спека `2026-10-27-subagent-reliability-design` §B.3).
    const { provider, seen } = spyProvider();
    const capped = withTokenCap(provider, 400, { maxExplicit: 32000 });
    await drain(capped.chat([{ role: "user", content: "x" }], undefined, undefined, { maxTokens: 800 }));
    expect(seen[0].maxTokens).toBe(800);
  });

  it("clamps an explicit limit to the hard ceiling", async () => {
    const { provider, seen } = spyProvider();
    const capped = withTokenCap(provider, 400, { maxExplicit: 32000 });
    await drain(
      capped.chat([{ role: "user", content: "x" }], undefined, undefined, { maxTokens: 999999 }),
    );
    expect(seen[0].maxTokens).toBe(32000);
  });

  it("keeps the provider identity", () => {
    const { provider } = spyProvider();
    const capped = withTokenCap(provider, 400);
    expect(capped.model).toBe("test-model");
    expect(capped.contextWindow).toBe(32000);
  });

  it("validates the value", () => {
    expect(parseMaxTokens(undefined)).toBeUndefined();
    expect(parseMaxTokens(400)).toBe(400);
    expect(parseMaxTokens(0)).toBe("invalid");
    expect(parseMaxTokens(999999)).toBe("invalid");
    expect(parseMaxTokens("abc")).toBe("invalid");
  });
});
