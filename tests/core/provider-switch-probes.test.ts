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
    process.env.MMA_REASONING_OFF_CACHE = join(
      mkdtempSync(join(tmpdir(), "mma-off-cache-")),
      "off-cache.json",
    );
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    delete process.env.MMA_REASONING_CACHE;
    delete process.env.MMA_REASONING_OFF_CACHE;
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

  it("publishes the new context probe for the web sidebar after a provider switch", async () => {
    const base = startLmStub();
    const config = testConfig([
      { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
      { type: "lmstudio", label: "newprov", baseUrl: base },
    ]);
    const deps = stubDeps(config, {
      capabilitiesProbeRef: {},
      contextProbeRef: { current: { model: "old-model", actual: 8192 } },
    });
    const agent = new Agent(deps as never);
    config.provider.active = "newprov";
    await agent.reconfigure(config);

    expect(agent.contextProbeSnapshot()).toEqual({ model: "new-model", actual: 65536 });
    expect(deps.contextProbeRef?.current).toEqual({ model: "new-model", actual: 65536 });
    expect(config.contextWindow).toBe(65536);
  });

  it("probe:false path does not touch the network and invalidates the stale verdict", async () => {    const base = startLmStub();
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

/**
 * Хостед-эндпоинты не декларируют выключатель reasoning (`/models` даёт только
 * `supported`/`effort`), поэтому `reasoningOff` выясняется одним минимальным
 * запросом с `reasoning_effort:"none"` (долг `hosted-reasoning-discovery`,
 * спека `2026-11-10-hosted-reasoning-off-discovery-design.md`).
 */
describe("hosted reasoning off-switch discovery (долг paid)", () => {
  let chatHits = 0;
  let chatBodies: string[] = [];
  let offStatus = 200;

  function startHostedStub(): string {
    chatHits = 0;
    chatBodies = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/v1/models")) {
          return Response.json({
            data: [
              {
                id: "deepseek-v4.1-flash",
                limit: { context: 1000000 },
                capabilities: {
                  tools: { supported: true },
                  reasoning: { supported: true, effort: ["low", "high", "max"] },
                },
              },
            ],
          });
        }
        if (url.pathname.endsWith("/chat/completions")) {
          return req.text().then((b) => {
            chatHits++;
            chatBodies.push(b);
            return offStatus === 200
              ? Response.json({ id: "x", choices: [{ message: { content: "ok" } }] })
              : new Response(JSON.stringify({ error: { message: "Unsupported parameter: reasoning_effort" } }), {
                  status: offStatus,
                });
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return `http://127.0.0.1:${server.port}/v1`;
  }

  beforeEach(() => {
    globalThis.fetch = REAL_FETCH;
    resetProbeCache();
    const dir = mkdtempSync(join(tmpdir(), "mma-hosted-probe-"));
    process.env.MMA_REASONING_CACHE = join(dir, "reasoning-cache.json");
    process.env.MMA_REASONING_OFF_CACHE = join(dir, "off-cache.json");
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    delete process.env.MMA_REASONING_CACHE;
    delete process.env.MMA_REASONING_OFF_CACHE;
  });

  async function switchToGo(baseUrl: string) {
    const config = testConfig(
      [
        { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
        { type: "opencode-go", label: "go", baseUrl, apiKey: "k" },
      ],
      "deepseek-v4.1-flash",
    );
    config.reasoning = { mode: "auto" };
    const deps = stubDeps(config, { capabilitiesProbeRef: {} });
    const agent = new Agent(deps as never);
    config.provider.active = "go";
    await agent.reconfigure(config);
    return { config, deps };
  }

  it("accepting none discovers the off-switch and its levels reach the probe", async () => {
    const base = startHostedStub();
    offStatus = 200;
    const { deps } = await switchToGo(base);

    // ≥1: после off-пробы фоном стартует и reasoning-проба (её ординалы тоже
    // идут в /chat/completions) — фиксируем, что выключатель найден, а не число.
    expect(chatHits).toBeGreaterThanOrEqual(1);
    expect(deps.capabilitiesProbeRef?.probe).toMatchObject({
      reasoningStrategy: "openai-effort",
      reasoningOff: true,
      reasoningLevels: ["low", "high", "max"],
    });
    // UI читает тот же резолв, что применён к провайдеру (INV-R8).
    expect(getRememberedReasoningMechanism(base, "deepseek-v4.1-flash")).toMatchObject({
      reasoningOff: true,
      levels: ["low", "high", "max"],
    });

    // Конец пути: экземпляр провайдера умеет выключать thinking, и фоновая
    // reasoning-проба реально шлёт `reasoning_effort:"none"` (симптом долга —
    // «none» не уходил никогда).
    const deadline = Date.now() + 5000;
    while (!chatBodies.some((b) => b.includes('"reasoning_effort":"none"')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(chatBodies.some((b) => b.includes('"reasoning_effort":"none"'))).toBe(true);
  });

  it("rejecting none records a strict endpoint (безопасно: none не шлём)", async () => {
    const base = startHostedStub();
    offStatus = 400;
    const { deps } = await switchToGo(base);
    expect(chatHits).toBe(1);
    expect(deps.capabilitiesProbeRef?.probe?.reasoningOff).toBe(false);
  });

  it("не слит пробное none бэкенду со стратегией prompt-tag", async () => {
    // Тип `openai-compat` (пресет prompt-tag) без собственных capabilities:
    // выключатель выражается тегом, а не параметром — LLM-проба не нужна.
    const base = startHostedStub();
    offStatus = 200;
    const config = testConfig(
      [
        { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
        { type: "openai-compat", label: "compat", baseUrl: base.replace("/v1", "/other/v1") },
      ],
      "not-listed-model",
    );
    config.reasoning = { mode: "auto" };
    const deps = stubDeps(config, { capabilitiesProbeRef: {} });
    const agent = new Agent(deps as never);
    config.provider.active = "compat";
    await agent.reconfigure(config);
    expect(chatHits).toBe(0);
    expect(deps.reasoningStrategy).toBe("prompt-tag");
  });

  it("не гоняет пробу, когда reasoning выключен значением mode:none", async () => {    const base = startHostedStub();
    offStatus = 200;
    const config = testConfig(
      [
        { type: "lmstudio", label: "oldprov", baseUrl: "http://127.0.0.1:1/v1" },
        { type: "opencode-go", label: "go", baseUrl: base, apiKey: "k" },
      ],
      "deepseek-v4.1-flash",
    );
    config.reasoning = { mode: "none" };
    const deps = stubDeps(config, { capabilitiesProbeRef: {} });
    const agent = new Agent(deps as never);
    config.provider.active = "go";
    await agent.reconfigure(config);
    expect(chatHits).toBe(0);
  });
});
