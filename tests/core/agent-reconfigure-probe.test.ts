import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";

function testConfig(): AppConfig {
  return {
    version: "2.0.0",
    model: "old-model",
    provider: { type: "lmstudio", baseUrl: "http://127.0.0.1:1/v1" },
    contextWindow: 32768,
    contextBudget: { systemPrompt: 0.1, responseReserve: 0.15, compactionThreshold: 0.75 },
  } as AppConfig;
}

function stubDeps(config: AppConfig) {
  return {
    config,
    llmProvider: {
      model: config.model,
      contextWindow: config.contextWindow,
      chat: async function* () {},
      countTokens: () => 1,
    },
    toolExecutor: { updateProvider: vi.fn() },
    contextManager: { resize: vi.fn() },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    baseDir: "/tmp",
    promptBlocks: [],
  };
}

/** LM Studio stub: only "new-model" is known, loaded with 65536. */
function mockLmStudio() {
  global.fetch = (async (url: unknown) => {
    if (String(url).endsWith("/api/v1/models")) {
      return {
        ok: true,
        json: async () => ({
          models: [
            {
              key: "new-model",
              max_context_length: 131072,
              loaded_instances: [{ config: { context_length: 65536 } }],
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as any;
}

describe("agent reconfigure probe", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("probes on model change even when the config object is mutated in place", async () => {
    mockLmStudio();
    const config = testConfig();
    const deps = stubDeps(config);
    const agent = new Agent(deps as any);
    // Every write path (REPL/web) mutates the live config, then passes the
    // SAME object to reconfigure — prev/next comparison would see no change.
    config.model = "new-model";
    await agent.reconfigure(config);
    expect(config.contextWindow).toBe(65536);
    expect(deps.contextManager.resize).toHaveBeenCalledWith(
      65536,
      config.contextBudget,
      expect.anything(),
    );
  });

  it("skips the probe when only an unrelated key changed", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls += 1;
      return { ok: false, status: 404, json: async () => ({}) };
    }) as any;
    const config = testConfig();
    const deps = stubDeps(config);
    const agent = new Agent(deps as any);
    config.maxToolIterations = 99;
    await agent.reconfigure(config);
    expect(fetchCalls).toBe(0);
    expect(config.contextWindow).toBe(32768);
  });

  it("probes again after switching back to the previous model", async () => {
    mockLmStudio();
    const config = testConfig();
    const deps = stubDeps(config);
    const agent = new Agent(deps as any);
    config.model = "new-model";
    await agent.reconfigure(config);
    expect(config.contextWindow).toBe(65536);
    config.model = "old-model";
    await agent.reconfigure(config);
    // "old-model" is unknown to the stub — the adopted value is kept.
    expect(config.contextWindow).toBe(65536);
  });
});
