import { describe, it, expect } from "vitest";
import { buildCriticProvider } from "../src/modules/critic/provider";
import { FallbackProvider } from "../src/modules/providers/fallback";
import type { LLMProvider } from "../src/llm/provider";
import type { AppConfig } from "../src/config/types";

function stubProvider(): LLMProvider {
  return {
    model: "active-model",
    contextWindow: 4096,
    countTokens: () => 0,
    listModels: async () => [],
    async *chat() {
      yield { type: "text" as const, content: "{}" };
      yield { type: "done" as const };
    },
  };
}

function baseConfig(): AppConfig {
  return {
    model: "active-model",
    provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
    contextWindow: 32768,
    retry: { maxRetries: 1, baseDelay: 10, maxDelay: 20 },
  } as AppConfig;
}

describe("buildCriticProvider (Phase 2)", () => {
  it("shares the active provider when no critic model is set", () => {
    const def = stubProvider();
    expect(buildCriticProvider(undefined, baseConfig(), def)).toBe(def);
    expect(buildCriticProvider({ enabled: true, tools: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 1 }, baseConfig(), def)).toBe(def);
  });

  it("ignores a provider override without a model (v1 behavior)", () => {
    const def = stubProvider();
    const critic = {
      enabled: true, tools: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 1,
      provider: { type: "openai-compat", baseUrl: "http://localhost:9999/v1" },
    };
    expect(buildCriticProvider(critic, baseConfig(), def)).toBe(def);
  });

  it("builds a managed provider when critic.model is set", () => {
    const def = stubProvider();
    const critic = {
      enabled: true, tools: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 1,
      model: "critic-model",
      provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
    };
    const built = buildCriticProvider(critic, baseConfig(), def);
    expect(built).not.toBe(def);
    expect(built.model).toBe("critic-model");
  });

  it("wraps in FallbackProvider when fallback is set with 2+ entries", () => {
    const def = stubProvider();
    const critic = {
      enabled: true, tools: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 1,
      model: "critic-model",
      provider: {
        fallback: true,
        entries: [
          { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
          { type: "openai-compat", baseUrl: "http://localhost:1235/v1" },
        ],
      },
    };
    const built = buildCriticProvider(critic, baseConfig(), def);
    expect(built).toBeInstanceOf(FallbackProvider);
  });

  it("tolerates an unknown provider type via the openai-compat fallback", () => {
    // createProvider never throws on unknown types (legacy behavior) — the
    // critic inherits it; construction still yields a managed provider.
    const def = stubProvider();
    const critic = {
      enabled: true, tools: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 1,
      model: "critic-model",
      provider: { type: "bogus-provider-type", baseUrl: "http://localhost:1/v1" },
    };
    const built = buildCriticProvider(critic, baseConfig(), def);
    expect(built).not.toBe(def);
    expect(built.model).toBe("critic-model");
  });
});
