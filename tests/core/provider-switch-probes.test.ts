// Смена идентичности провайдера/модели обязана перепробить ВСЕ данные бэкенда
// (INV-R2/R8): capabilities, reasoning-поддержку. Спека:
// docs/specs/2026-11-10-provider-switch-probes-design.md
//
// LM Studio-стаб — настоящий локальный HTTP-сервер + нативный Bun.fetch, а не
// мок global.fetch: `bun test` гоняет файлы конкурентно в одном процессе.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";
import {
  getRememberedReasoningMechanism,
  resetProbeCache,
} from "../../src/modules/reasoning/probe";

const REAL_FETCH: typeof fetch = Bun.fetch.bind(Bun) as typeof fetch;

/** `probePassed` — protected поле агента; читаем через узкий тестовый вид. */
function probePassedOf(agent: Agent): boolean {
  return (agent as unknown as { probePassed: boolean }).probePassed;
}

let server: ReturnType<typeof Bun.serve> | undefined;
let requestCount = 0;

/** Отвечает LM Studio-native `/api/v1/models` с discovery-возможностями модели. */
function startLmStub(): string {
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
              capabilities: {
                vision: false,
                reasoning: { allowed_options: ["off", "on"], default: "on" },
              },
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

function stubDeps(config: AppConfig, extras: Record<string, unknown> = {}) {
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
    logger: { debug() {}, info() {}, warn() {}, error() {}, diagnostic() {}, logSilent() {} },
    baseDir: "/tmp",
    promptBlocks: [],
    ...extras,
  };
}

interface EntrySpec {
  type: string;
  label: string;
  baseUrl: string;
}

function testConfig(entries: EntrySpec[], model = "new-model"): AppConfig {
  return {
    version: "2.0.0",
    model,
    provider: { type: entries[0]?.type ?? "openai-compat", active: entries[0]?.label, entries },
    contextWindow: 32768,
    contextBudget: { systemPrompt: 0.1, responseReserve: 0.15, compactionThreshold: 0.75 },
    modelLoad: { autoLoad: false },
    retry: { maxRetries: 0, baseDelay: 1, maxDelay: 1 },
  } as AppConfig;
}

const STALE_PROBE = {
  reasoningStrategy: "template-kwarg",
  reasoningOff: true,
  reasoningLevels: ["low", "medium"],
  vision: true,
} as const;

describe("provider switch re-probes capabilities (INV-R2)", () => {
  beforeEach(() => {
    globalThis.fetch = REAL_FETCH;
    resetProbeCache();
    process.env.MMA_REASONING_CACHE = join(
      mkdtempSync(join(tmpdir(), "mma-reasoning-test-")),
      "reasoning-cache.json",
    );
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    delete process.env.MMA_REASONING_CACHE;
  });

  it("replaces the stale probe with discovery of the NEW provider", async () => {
    const base = startLmStub();
    const config = testConfig([
      { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
      { type: "lmstudio", label: "newprov", baseUrl: base },
    ]);
    const deps = stubDeps(config, {
      capabilitiesProbeRef: { probe: { ...STALE_PROBE } },
    });
    const agent = new Agent(deps as never);
    // In-place mutation — сценарий `/provider use` / веб-свитча.
    config.provider.active = "newprov";
    await agent.reconfigure(config);

    // Данные нового бэкенда, а не прошлого: probe перезаписан, стратегия из
    // discovery (LM Studio off/on → openai-effort + none, без granular levels).
    expect(deps.capabilitiesProbeRef?.probe).toEqual({
      vision: false,
      reasoningStrategy: "openai-effort",
      reasoningOff: true,
      reasoningLevels: [],
    });
    expect(deps.reasoningStrategy).toBe("openai-effort");
    expect(deps.reasoningLevels).toEqual([]);
  });

  it("resets stale capabilities when the new backend declares nothing", async () => {
    const config = testConfig(
      [
        { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
        { type: "opencode-go", label: "newprov", baseUrl: "http://127.0.0.1:1/go/v1" },
      ],
      "iceman-contributor-free",
    );
    const deps = stubDeps(config, {
      capabilitiesProbeRef: { probe: { ...STALE_PROBE } },
    });
    const agent = new Agent(deps as never);
    config.provider.active = "newprov";
    await agent.reconfigure(config);

    // Чужие данные опаснее отсутствия: probe сброшен → пресет opencode-go.
    expect(deps.capabilitiesProbeRef?.probe).toBeUndefined();
    expect(deps.reasoningStrategy).toBe("openai-effort");
    expect(deps.reasoningLevels).toBeUndefined();
    // Fail-open: контекст не тронут недоступным бэкендом.
    expect(config.contextWindow).toBe(32768);
  });

  it("refreshes capabilities even when contextAuto is off", async () => {
    const base = startLmStub();
    const config = testConfig([
      { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
      { type: "lmstudio", label: "newprov", baseUrl: base },
    ]);
    config.contextAuto = false;
    const deps = stubDeps(config, {
      capabilitiesProbeRef: { probe: { ...STALE_PROBE } },
    });
    const agent = new Agent(deps as never);
    config.provider.active = "newprov";
    await agent.reconfigure(config);

    // capabilities — свойство бэкенда, не окна: перепрашиваются и при contextAuto=false.
    expect(deps.capabilitiesProbeRef?.probe).toEqual({
      vision: false,
      reasoningStrategy: "openai-effort",
      reasoningOff: true,
      reasoningLevels: [],
    });
    // Окно при этом не тронуто.
    expect(config.contextWindow).toBe(32768);
  });

  it("remembers the applied mechanism for the new pair (INV-R8)", async () => {
    const base = startLmStub();
    const config = testConfig([
      { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
      { type: "lmstudio", label: "newprov", baseUrl: base },
    ]);
    const deps = stubDeps(config, {
      capabilitiesProbeRef: { probe: { ...STALE_PROBE } },
    });
    const agent = new Agent(deps as never);
    config.provider.active = "newprov";
    await agent.reconfigure(config);

    // UI (buildReasoningView) читает механизм пары baseUrl|model — он должен
    // совпадать с применённой стратегией, иначе селектор врёт.
    const remembered = getRememberedReasoningMechanism(base, "new-model");
    expect(remembered).toMatchObject({
      strategy: deps.reasoningStrategy,
      reasoningOff: true,
      levels: [],
    });
  });

  it("resets probePassed until the new background probe resolves (B2)", async () => {
    const config = testConfig(
      [
        { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
        { type: "opencode-go", label: "newprov", baseUrl: "http://127.0.0.1:1/go/v1" },
      ],
      "iceman-contributor-free",
    );
    config.reasoning = { mode: "auto" };
    const deps = stubDeps(config, {
      capabilitiesProbeRef: { probe: { reasoningStrategy: "openai-effort", reasoningOff: false } },
      reasoningProbePassed: true,
      reasoningProbe: () => Promise.resolve(true),
    });
    const agent = new Agent(deps as never);
    config.provider.active = "newprov";
    await agent.reconfigure(config);

    // Сразу после свитча вердикт прошлой пары не применяется.
    expect(probePassedOf(agent)).toBe(false);
    // openai-effort без off-switch подтверждается без сети → фоновая проба
    // возвращает probePassed в true для новой пары.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(probePassedOf(agent)).toBe(true);
  });

  it("probe:false path does not touch the network and invalidates the stale verdict", async () => {
    const base = startLmStub();
    const config = testConfig([
      { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
      { type: "lmstudio", label: "newprov", baseUrl: base },
    ]);
    const stale = { ...STALE_PROBE };
    const deps = stubDeps(config, {
      capabilitiesProbeRef: { probe: stale },
      reasoningProbePassed: true,
      reasoningProbe: () => Promise.resolve(true),
    });
    const agent = new Agent(deps as never);
    config.provider.active = "newprov";
    await agent.reconfigure(config, { probe: false });

    // Ни одного сетевого запроса к новому бэкенду: сеть — дело основного агента.
    expect(requestCount).toBe(0);
    // Чужой вердикт недействителен, capabilities не перезаписаны раннером.
    expect(probePassedOf(agent)).toBe(false);
    await expect(deps.reasoningProbe!()).resolves.toBe(false);
    expect(deps.capabilitiesProbeRef?.probe).toEqual(stale);
  });
});
