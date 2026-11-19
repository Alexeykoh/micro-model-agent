import { describe, it, expect } from "vitest";
import { CriticClient } from "../src/modules/critic/client";
import type { EvidencePack } from "../src/modules/critic/types";
import type { LLMProvider } from "../src/llm/provider";

/**
 * Бюджет генерации критика (W4, INV-C5).
 *
 * Реальная поломка: клиент критика слал `max_tokens: 2048`, перебивая
 * провайдерский `maxCompletionTokens` (8192 — «для reasoning-моделей»). У
 * reasoning-моделей весь лимит уходил на размышление, `finish_reason: length`
 * давал `LlmError` («Ответ упёрся в лимит токенов генерации (2048)») — вердикт
 * не доходил, критик fail-open'ился.
 */
const pack: EvidencePack = { task: "t", changedFiles: [], commands: [], toolDigest: "" };
const okVerdict = '{"status":"ok","summary":"fine","issues":[]}';

/** Провайдер, который запоминает присланный лимит токенов. */
function providerWithCap(cap: number | undefined): {
  provider: LLMProvider;
  seen: number[];
} {
  const seen: number[] = [];
  const provider: LLMProvider = {
    model: "m",
    contextWindow: 1000,
    maxCompletionTokens: cap,
    countTokens: () => 0,
    listModels: async () => [],
    async *chat(_m, _t, _s, options) {
      seen.push((options?.maxTokens as number) ?? 0);
      yield { type: "text" as const, content: okVerdict };
      yield { type: "done" as const };
    },
  };
  return { provider, seen };
}

describe("critic token budget (W4)", () => {
  it("does not cut the provider's completion budget", async () => {
    const { provider, seen } = providerWithCap(8192);
    const client = new CriticClient({ provider, maxTokens: 2048 });
    await client.verify(pack);
    expect(seen[0]).toBe(8192);
  });

  it("uses the provider's budget even with the default critic limit", async () => {
    const { provider, seen } = providerWithCap(8192);
    const client = new CriticClient({ provider });
    await client.verify(pack);
    expect(seen[0]).toBe(8192);
  });

  it("keeps its own limit when the provider declares none", async () => {
    const { provider, seen } = providerWithCap(undefined);
    const client = new CriticClient({ provider, maxTokens: 4096 });
    await client.verify(pack);
    expect(seen[0]).toBe(4096);
  });

  it("never goes below the critic's own floor", async () => {
    const { provider, seen } = providerWithCap(1024);
    const client = new CriticClient({ provider, maxTokens: 4096 });
    await client.verify(pack);
    expect(seen[0]).toBe(4096);
  });
});
