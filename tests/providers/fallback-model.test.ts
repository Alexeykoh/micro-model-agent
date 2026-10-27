import { describe, it, expect } from "vitest";
import { FallbackProvider, isFailoverError } from "../../src/modules/providers/fallback";
import { ProviderManager } from "../../src/modules/providers/manager";
import { sharedRateLimiter, resetSharedRateLimiter } from "../../src/llm/shared-rate-limiter";
import { LlmError } from "../../src/llm/llm-errors";
import type { LLMProvider } from "../../src/llm/provider";

/**
 * Failover переключается на модель целевого провайдера, а лимиты запросов
 * общие для раннеров сессий (аудит §7.7/§7.8, план
 * `2026-10-12-harness-module-audit-fixes`, W7/Task 7.4).
 */

function stubProvider(model: string, fail?: Error): LLMProvider {
  return {
    model,
    contextWindow: 32000,
    countTokens: (t: string) => t.length,
    listModels: async () => [model],
    chat: async function* () {
      if (fail) throw fail;
      yield { type: "done" };
    },
  } as unknown as LLMProvider;
}

describe("failover: модель целевого провайдера", () => {
  it("switches to the target provider's own model", async () => {
    const calls: Array<{ name: string; model?: string }> = [];
    const source = {
      activeName: "a",
      listNames: () => ["a", "b"],
      modelFor: (name: string) => (name === "b" ? "m2" : undefined),
      switch(name: string, model?: string) {
        calls.push({ name, model });
        return stubProvider(model ?? "m1");
      },
      active: stubProvider("m1", new LlmError("model not found", { llmStatus: 404 })),
    };

    const provider = new FallbackProvider(source);
    for await (const _chunk of provider.chat([{ role: "user", content: "x" }])) {
      /* пусто */
    }

    expect(calls[0]?.name).toBe("b");
    expect(calls[0]?.model).toBe("m2");
  });

  it("a 403 region/license refusal is a failover error", () => {
    // ses_mvoac9q9: RegionError активного провайдера — повод переключиться,
    // а не умирать ходом.
    expect(isFailoverError(new LlmError("region", { llmStatus: 403 }))).toBe(true);
    // Ошибка запроса/ключа — не повод: смена провайдера её не лечит.
    expect(isFailoverError(new LlmError("auth", { llmStatus: 401 }))).toBe(false);
    expect(isFailoverError(new LlmError("bad", { llmStatus: 422 }))).toBe(false);
  });

  it("switches the provider after a 403", async () => {
    const calls: string[] = [];
    const source = {
      activeName: "a",
      listNames: () => ["a", "b"],
      modelFor: () => undefined,
      switch(name: string) {
        calls.push(name);
        return stubProvider(name === "b" ? "m2" : "m1");
      },
      active: stubProvider("m1", new LlmError("region", { llmStatus: 403 })),
    };

    const provider = new FallbackProvider(source);
    const chunks: unknown[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "x" }])) chunks.push(chunk);

    expect(calls).toEqual(["b"]);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("a 404 model-not-found is a failover error", () => {
    expect(isFailoverError(new LlmError("not found", { llmStatus: 404 }))).toBe(true);
    expect(isFailoverError(new LlmError("rate", { llmStatus: 429 }))).toBe(true);
    expect(isFailoverError(new LlmError("bad", { llmStatus: 400 }))).toBe(false);
  });

  it("the manager remembers the per-provider model and the active choice", () => {
    const manager = new ProviderManager(
      {
        type: "openai-compat",
        baseUrl: "https://a/v1",
        entries: [
          { type: "openai-compat", label: "a", baseUrl: "https://a/v1" },
          { type: "openai-compat", label: "b", baseUrl: "https://b/v1" },
        ],
        models: { a: "m1", b: "m2" },
      },
      { contextWindow: 32000 },
    );
    expect(manager.modelFor("b")).toBe("m2");
    manager.switch("b", "m2");
    expect(manager.activeName).toBe("b");
  });
});

describe("лимиты провайдера: общие на процесс", () => {
  it("rate limits are shared across session runners", () => {
    resetSharedRateLimiter();
    const limiter = sharedRateLimiter({ maxRequestsPerMinute: 10 });
    const other = sharedRateLimiter({ maxRequestsPerMinute: 10 });
    expect(other).toBe(limiter);
    resetSharedRateLimiter();
  });
});
