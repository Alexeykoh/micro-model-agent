// Эмпирическая проба выключателя reasoning (долг `hosted-reasoning-discovery`,
// спека docs/specs/2026-11-10-hosted-reasoning-off-discovery-design.md):
// 200 → off есть, 400/422 → строгий, остальное → «не знаем»; кэш по идентичности.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeReasoningOffSwitch,
  resetReasoningOffCache,
} from "../../src/llm/reasoning-off-probe";
import { probeOpenAICompatCapabilities } from "../../src/llm/native-context";

const REAL_FETCH: typeof fetch = Bun.fetch.bind(Bun) as typeof fetch;

let server: ReturnType<typeof Bun.serve> | undefined;
let lastRequest: { path: string; headers: Record<string, string>; body: string } | null = null;
let hits = 0;

/** Эндпоинт, отвечающий `status` на `POST /chat/completions`. */
function startStub(status: number, errorBody = "Unsupported parameter: 'reasoning_effort'"): string {
  hits = 0;
  lastRequest = null;
  server?.stop(true);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      hits++;
      const url = new URL(req.url);
      if (url.pathname.endsWith("/chat/completions")) {
        return req
          .text()
          .catch(() => "")
          .then((b) => {
            lastRequest = {
              path: url.pathname,
              headers: Object.fromEntries(req.headers.entries()),
              body: b,
            };
            return status === 200
              ? Response.json({ id: "x", choices: [{ message: { content: "ok" } }] })
              : new Response(JSON.stringify({ error: { message: errorBody } }), {
                  status,
                  headers: { "Content-Type": "application/json" },
                });
          });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

describe("probeReasoningOffSwitch", () => {
  let cachePath: string | undefined;

  beforeEach(() => {
    globalThis.fetch = REAL_FETCH;
    cachePath = join(mkdtempSync(join(tmpdir(), "mma-off-probe-")), "off-cache.json");
    process.env.MMA_REASONING_OFF_CACHE = cachePath;
    resetReasoningOffCache();
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    delete process.env.MMA_REASONING_OFF_CACHE;
  });

  it("reads 200 as 'endpoint accepts none'", async () => {
    const base = startStub(200);
    expect(await probeReasoningOffSwitch(base, "m", { providerType: "opencode-go" })).toBe(true);
    expect(hits).toBe(1);
    // Проба шлёт ровно ту форму, которой харнесс выражает off.
    expect(lastRequest?.body).toContain('"reasoning_effort":"none"');
    // Zen/Go требуют session-заголовок — проба обязана его давать.
    expect(lastRequest?.headers["x-opencode-session"]).toBeTruthy();
  });

  it("reads 400 as 'strict endpoint' and caches the verdict", async () => {
    const base = startStub(400);
    expect(await probeReasoningOffSwitch(base, "m", { providerType: "openrouter" })).toBe(false);
    expect(hits).toBe(1);
    // Второй вызов — из кэша, без сети.
    expect(await probeReasoningOffSwitch(base, "m", { providerType: "openrouter" })).toBe(false);
    expect(hits).toBe(1);
  });

  it("strict verdict also comes from the generic 'unknown parameter' wording", async () => {
    const base = startStub(400, "unknown parameter in query string: reasoning");
    expect(await probeReasoningOffSwitch(base, "m")).toBe(false);
  });

  it("treats 5xx/401/timeout as unknown and does not cache it", async () => {
    const base = startStub(503);
    expect(await probeReasoningOffSwitch(base, "m")).toBeNull();
    expect(await probeReasoningOffSwitch(base, "m")).toBeNull();
    expect(hits).toBe(2);
  });

  it("does not read an unrelated 400 as a strict endpoint", async () => {
    // Живые случаи opencode-go: 400 про политику обучения (обёрнут в
    // `invalid_request_error`) и 400 про отсутствующий session-заголовок.
    const training = startStub(
      400,
      '{"type":"error","error":{"type":"invalid_request_error","message":"This Go model trains on request data. Turn on \\"Allow paid endpoints\\" to use it."}}',
    );
    expect(await probeReasoningOffSwitch(training, "m")).toBeNull();
    const noSession = startStub(
      400,
      '{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently"}}',
    );
    expect(await probeReasoningOffSwitch(noSession, "m")).toBeNull();
  });

  it("sends the bearer key for hosted endpoints", async () => {
    const base = startStub(200);
    await probeReasoningOffSwitch(base, "m", { apiKey: "sk-test", providerType: "openai" });
    expect(lastRequest?.headers["authorization"]).toBe("Bearer sk-test");
    expect(lastRequest?.headers["x-opencode-session"]).toBeUndefined();
  });

  it("keeps the cache isolated per model", async () => {
    const base = startStub(200);
    expect(await probeReasoningOffSwitch(base, "model-a")).toBe(true);
    expect(hits).toBe(1);
    expect(await probeReasoningOffSwitch(base, "model-b")).toBe(true);
    // Другая модель — другой ключ: проба обязательна.
    expect(hits).toBe(2);
  });
});

describe("probeOpenAICompatCapabilities", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads declared reasoning levels from /models (INV-R7)", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "deepseek-v4.1-flash",
            capabilities: { reasoning: { supported: true, effort: ["low", "high", "max"] } },
          },
        ],
      }),
    })) as unknown as typeof globalThis.fetch;
    const probe = await probeOpenAICompatCapabilities(
      "https://opencode.ai/zen/go/v1",
      "deepseek-v4.1-flash",
      "k",
      3000,
    );
    expect(probe).toEqual({
      reachable: true,
      capabilities: { reasoningStrategy: "openai-effort", reasoningLevels: ["low", "high", "max"] },
    });
  });

  it("reports supported-only models without inventing levels", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "m", capabilities: { reasoning: { supported: true } } }],
      }),
    })) as unknown as typeof globalThis.fetch;
    expect(await probeOpenAICompatCapabilities("http://x/v1", "m", undefined, 3000)).toEqual({
      reachable: true,
      capabilities: { reasoningStrategy: "openai-effort" },
    });
  });

  it("marks an answered endpoint reachable when the entry declares nothing", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "m" }] }),
    })) as unknown as typeof globalThis.fetch;
    expect(await probeOpenAICompatCapabilities("http://x/v1", "m", undefined, 3000)).toEqual({
      reachable: true,
      capabilities: undefined,
    });
  });

  it("marks a failed list probe unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    expect(await probeOpenAICompatCapabilities("http://x/v1", "m", undefined, 3000)).toEqual({
      reachable: false,
    });
  });
});
