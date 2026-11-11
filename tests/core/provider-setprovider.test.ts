// Память моделей провайдеров (INV-19) на путях hot-swap: `Agent.setProvider`
// (CLI `mma provider use`) и `ProviderManager.toConfig`.
import { describe, it, expect, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import { ProviderManager } from "../../src/modules/providers/manager";
import type { AppConfig, ProviderConfig } from "../../src/config/types";

function stubConfig(): AppConfig {
  return {
    version: "2.0.0",
    model: "qwen3.8-27b",
    provider: {
      type: "openai-compat",
      baseUrl: "http://127.0.0.1:1/v1",
      active: "llama.cpp",
      models: { "llama.cpp": "qwen3.8-27b", "opencode-go": "iceman-contributor-free" },
      entries: [
        { type: "openai-compat", label: "llama.cpp", baseUrl: "http://127.0.0.1:1/v1" },
        { type: "opencode-go", label: "opencode-go", baseUrl: "http://127.0.0.1:1/go/v1" },
      ],
    },
    contextWindow: 100096,
    contextBudget: { systemPrompt: 0.1, responseReserve: 0.15, compactionThreshold: 0.75 },
    modelLoad: { autoLoad: false },
    retry: { maxRetries: 0, baseDelay: 1, maxDelay: 1 },
  } as AppConfig;
}

function stubDeps(config: AppConfig) {
  return {
    config,
    llmProvider: {
      model: config.model,
      contextWindow: 100096,
      chat: async function* () {},
      countTokens: () => 1,
    },
    toolExecutor: { updateProvider: vi.fn() },
    contextManager: { resize: vi.fn() },
    logger: { debug() {}, info() {}, warn() {}, error() {}, diagnostic() {}, logSilent() {} },
    baseDir: "/tmp",
    promptBlocks: [],
  };
}

describe("setProvider restores the provider's remembered model (INV-19)", () => {
  it("applies provider.models[active] instead of the previous provider's model", async () => {
    const config = stubConfig();
    const agent = new Agent(stubDeps(config) as never);
    await agent.setProvider("opencode-go");
    expect(config.model).toBe("iceman-contributor-free");
    expect(config.provider.active).toBe("opencode-go");
    // Память не потеряна и дополнена фактом использования.
    expect(config.provider.models).toEqual({
      "llama.cpp": "qwen3.8-27b",
      "opencode-go": "iceman-contributor-free",
    });
  });

  it("keeps the current model when nothing is remembered for the new provider", async () => {
    const config = stubConfig();
    delete config.provider.models;
    const agent = new Agent(stubDeps(config) as never);
    await agent.setProvider("opencode-go");
    expect(config.model).toBe("qwen3.8-27b");
    // Факт использования запоминается — обратный свитч вернёт его.
    expect(config.provider.models).toEqual({ "opencode-go": "qwen3.8-27b" });
  });

  it("explicit model argument wins over the memory", async () => {
    const config = stubConfig();
    const agent = new Agent(stubDeps(config) as never);
    await agent.setProvider("opencode-go", "deepseek-v4.1-flash");
    expect(config.model).toBe("deepseek-v4.1-flash");
    expect(config.provider.models?.["opencode-go"]).toBe("deepseek-v4.1-flash");
  });
});

/** Пробы сети не нужны: контекст-проба fail-open, но лишний шум мешает. */
describe("ProviderManager.toConfig preserves provider.models", () => {
  it("keeps the models memory on hot-swap serialization", () => {
    const cfg: ProviderConfig = {
      type: "openai-compat",
      baseUrl: "http://x/v1",
      active: "a",
      models: { a: "model-a", b: "model-b" },
      entries: [
        { type: "openai-compat", label: "a", baseUrl: "http://x/v1" },
        { type: "opencode-go", label: "b", baseUrl: "http://y/v1" },
      ],
    };
    const m = new ProviderManager(cfg, { contextWindow: 32768 });
    m.switch("b");
    expect(m.toConfig().models).toEqual({ a: "model-a", b: "model-b" });
  });
});
