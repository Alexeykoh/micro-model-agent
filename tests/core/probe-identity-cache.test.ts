// INV-W6 (§4 B3): измеренное окно кешируется по идентичности
// `baseUrl + model + type` — возврат на уже измеренную идентичность не ходит
// в сеть и берёт окно из кеша. До правки каждая смена идентичности снова
// спрашивала провайдера (3-й переключение = 3-й сетевой запрос).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";

function testConfig(): AppConfig {
  return {
    version: "2.0.0",
    model: "m1",
    provider: { type: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" },
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
    toolExecutor: { updateProvider: () => {} },
    contextManager: { resize: () => {} },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    baseDir: "/tmp",
    promptBlocks: [],
  };
}

describe("agent probe identity cache", () => {
  let originalFetch: typeof global.fetch;
  /** Сетевые ходы на LM Studio `/api/v1/models`. */
  let nativeHits: number;
  /** Текущая модель стаба: m2 отдаёт 65536, m1 — 32768. */
  let currentModel: "m1" | "m2";
  /** false — «сеть мертва»: любая проба возвращает пустой ответ. */
  let live: boolean;

  beforeEach(() => {
    originalFetch = global.fetch;
    nativeHits = 0;
    currentModel = "m1";
    live = true;
    global.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/api/v1/models")) {
        nativeHits += 1;
        if (!live) return { ok: false, status: 503, json: async () => ({}) };
        const contextLength = currentModel === "m2" ? 65536 : 32768;
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                key: currentModel,
                loaded_instances: [{ config: { context_length: contextLength } }],
              },
            ],
          }),
        };
      }
      // Прочие источники (Ollama/llama.cpp/compat) молчат — это норма.
      return { ok: false, status: 404, json: async () => ({}) };
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("serves a repeat switch from cache without touching the network", async () => {
    const config = testConfig();
    const agent = new Agent(stubDeps(config) as never);

    // 1) Первый переключение на m2: измеряем (сетевой запрос №1).
    currentModel = "m2";
    config.model = "m2";
    await agent.reconfigure(config);
    expect(nativeHits).toBe(1);
    expect(config.contextWindow).toBe(65536);

    // 2) Переключение на m1: измеряем (сетевой запрос №2).
    currentModel = "m1";
    config.model = "m1";
    await agent.reconfigure(config);
    expect(nativeHits).toBe(2);
    expect(config.contextWindow).toBe(32768);

    // 3) Возврат на m2 при мёртвой сети: окно берётся из кеша, сеть не нужна.
    live = false;
    config.model = "m2";
    await agent.reconfigure(config);
    expect(nativeHits).toBe(2);
    expect(config.contextWindow).toBe(65536);

    // 4) Повтор на той же идентичности вообще не пробует (ни сети, ни кеша).
    config.model = "m2";
    await agent.reconfigure(config);
    expect(nativeHits).toBe(2);
    expect(config.contextWindow).toBe(65536);
  });
});
