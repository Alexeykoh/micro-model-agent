import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";

/**
 * LM Studio stub — настоящий локальный HTTP-сервер, а не мок global.fetch:
 * `bun test` гоняет файлы тестов конкурентно в одном процессе, и мутация
 * global.fetch дрейфует в пробы соседних файлов (POSIX CI: INV-R2-тест
 * падал на пустом reasoningStrategy). Сервер на 127.0.0.1 hermetic.
 */
let server: ReturnType<typeof Bun.serve> | undefined;
let requestCount = 0;

/**
 * Реальный fetch: соседние файлы мокают global.fetch (не все восстанавливают),
 * а global-this capture у них тоже отравлен цепочкой. `Bun.fetch` — рантаймный
 * натив, иммунитетом к подмене свойства global.fetch (трюк probe-parallel.test.ts).
 */
const REAL_FETCH: typeof fetch = Bun.fetch.bind(Bun) as typeof fetch;

async function startLmStudioStub(): Promise<string> {
  requestCount = 0;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      requestCount++;
      const url = new URL(req.url);
      if (url.pathname.endsWith("/api/v1/models")) {
        return Response.json({
          models: [
            {
              key: "new-model",
              max_context_length: 131072,
              loaded_instances: [{ config: { context_length: 65536 } }],
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

function testConfig(baseUrl: string): AppConfig {
  return {
    version: "2.0.0",
    model: "old-model",
    provider: { type: "lmstudio", baseUrl },
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

/** Agent принимает полный AgentDeps; стаб покрывает только используемые поля. */
function makeAgent(deps: object): Agent {
  return new Agent(deps as any);
}

describe("agent reconfigure probe", () => {
  let baseUrl: string;

  beforeEach(async () => {
    // Восстановить реальный fetch: соседние файлы мокают global.fetch и
    // оставляют мок включённым (порядковая поллюция между файлами).
    globalThis.fetch = REAL_FETCH;
    baseUrl = await startLmStudioStub();
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  it("probes on model change even when the config object is mutated in place", async () => {
    const config = testConfig(baseUrl);
    const deps = stubDeps(config);
    const agent = makeAgent(deps);
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

  it("reprobes provider with discovered capabilities (INV-R2)", async () => {
    const config = testConfig(baseUrl);
    const deps = {
      ...stubDeps(config),
      capabilitiesProbeRef: {
        probe: {
          reasoningStrategy: "openai-effort" as const,
          reasoningOff: true,
          reasoningLevels: ["low", "medium", "xhigh"],
        },
      },
    };
    const agent = makeAgent(deps);
    config.model = "new-model";
    await agent.reconfigure(config);
    // Стратегия и экземпляр провайдера обязаны видеть discovery, а не пресет
    // (`prompt-tag`), иначе `none` молча превращается в `/no_think`.
    expect(deps.reasoningStrategy).toBe("openai-effort");
    const provider = deps.llmProvider as unknown as {
      reasoningStrategy?: string;
      reasoningLevels?: string[];
    };
    expect(provider.reasoningStrategy).toBe("openai-effort");
    expect(provider.reasoningLevels).toEqual(["low", "medium", "xhigh"]);
  });

  it("skips the probe when only an unrelated key changed", async () => {
    const config = testConfig(baseUrl);
    const deps = stubDeps(config);
    const agent = makeAgent(deps);
    config.maxToolIterations = 99;
    const before = requestCount;
    await agent.reconfigure(config);
    expect(requestCount).toBe(before);
    expect(config.contextWindow).toBe(32768);
  });

  it("probes again after switching back to the previous model", async () => {
    const config = testConfig(baseUrl);
    const deps = stubDeps(config);
    const agent = makeAgent(deps);
    config.model = "new-model";
    await agent.reconfigure(config);
    expect(config.contextWindow).toBe(65536);
    config.model = "old-model";
    await agent.reconfigure(config);
    // "old-model" is unknown to the stub — the adopted value is kept.
    expect(config.contextWindow).toBe(65536);
  });
});
