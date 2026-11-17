/**
 * `GET /api/models?provider=<name>` — модели конкретной записи провайдера для
 * страницы экспертов. Кеш ленивый: первый запрос отвечает `loading: true` и
 * запускает `listModels()`; следующий отдаёт список.
 *
 * Спека `2026-11-01-experts-model-selection-design`, §2.5.
 */
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { makeModelCache } from "../src/modules/webui/settings/model-cache";
import { handleModelsGet } from "../src/modules/webui/settings/config-api";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";

function config(): AppConfig {
  const c = structuredClone(DEFAULTS);
  c.provider = {
    type: "openai-compat",
    baseUrl: "http://localhost:1234/v1",
    entries: [
      { type: "openai-compat", label: "local", baseUrl: "http://localhost:1234/v1" },
      { type: "openai-compat", label: "remote", baseUrl: "https://remote.example/v1" },
    ],
    active: "local",
  } as AppConfig["provider"];
  return c;
}

const modelsByProvider: Record<string, string[]> = {
  local: ["local-a", "local-b"],
  remote: ["remote-a"],
};

function agentStub() {
  return {
    getProviderFor: (name: string) => ({
      listModels: async () => modelsByProvider[name] ?? [],
    }),
  } as never;
}

/** Минимальный Response-стаб: перехватывает JSON-тело ответа. */
function resStub(): { res: ServerResponse; body: () => Record<string, unknown> } {
  let raw = "";
  const res = {
    writeHead: () => res,
    end: (chunk: string) => {
      raw += chunk;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, body: () => JSON.parse(raw) as Record<string, unknown> };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("model cache per provider", () => {
  it("reports loading on the first call and the list afterwards", async () => {
    const cache = makeModelCache(agentStub(), config());
    expect(cache.getFor("remote")).toEqual({ models: [], loading: true });
    await flush();
    expect(cache.getFor("remote")).toEqual({ models: ["remote-a"], loading: false });
  });

  it("empty name falls back to the active provider without loading", async () => {
    const cache = makeModelCache(agentStub(), config());
    await cache.refresh();
    expect(cache.get()).toEqual(["local-a", "local-b"]);
    expect(cache.getFor("")).toEqual({ models: ["local-a", "local-b"], loading: false });
  });

  it("an offline provider yields an empty list instead of hanging", async () => {
    const cache = makeModelCache(
      {
        getProviderFor: () => ({
          listModels: async () => {
            throw new Error("offline");
          },
        }),
      } as never,
      config(),
    );
    expect(cache.getFor("remote").loading).toBe(true);
    await flush();
    expect(cache.getFor("remote")).toEqual({ models: [], loading: false, error: true });
  });

  it("reports the active provider's loading/error state", async () => {
    const cache = makeModelCache(agentStub(), config());
    expect(cache.getActiveState()).toEqual({ models: [], loading: true });
    await cache.refresh();
    expect(cache.getActiveState()).toEqual({
      models: ["local-a", "local-b"],
      loading: false,
    });
  });

  it("marks an offline active provider as an error, not as an empty list", async () => {
    const cache = makeModelCache(
      {
        getProviderFor: () => ({
          listModels: async () => {
            throw new Error("offline");
          },
        }),
      } as never,
      config(),
    );
    await cache.refresh();
    expect(cache.getActiveState()).toEqual({ models: [], loading: false, error: true });
  });

  it("keeps a known list ready while a background refresh is in flight", async () => {
    let release: (models: string[]) => void = () => {};
    const pending = new Promise<string[]>((r) => {
      release = r;
    });
    let calls = 0;
    const cache = makeModelCache(
      {
        getProviderFor: () => ({
          listModels: () => (++calls === 1 ? Promise.resolve(["a", "b"]) : pending),
        }),
      } as never,
      config(),
    );
    await cache.refresh();
    expect(cache.getActiveState()).toEqual({ models: ["a", "b"], loading: false });
    const second = cache.refresh();
    await flush();
    // Обновление идёт, но список уже есть: панель не должна уходить в «загрузку».
    expect(cache.getActiveState()).toEqual({ models: ["a", "b"], loading: false });
    release(["a", "b", "c"]);
    await second;
    expect(cache.getActiveState()).toEqual({ models: ["a", "b", "c"], loading: false });
  });

  it("keeps the previous list when a later refresh fails", async () => {
    let calls = 0;
    const cache = makeModelCache(
      {
        getProviderFor: () => ({
          listModels: async () => {
            if (++calls === 1) return ["a"];
            throw new Error("offline");
          },
        }),
      } as never,
      config(),
    );
    await cache.refresh();
    await cache.refresh();
    expect(cache.getActiveState()).toEqual({ models: ["a"], loading: false });
  });
});

describe("GET /api/models?provider=", () => {
  it("returns the provider-scoped list with the provider name", () => {
    const cache = makeModelCache(agentStub(), config());
    const { res, body } = resStub();
    const req = { url: "/api/models?provider=remote" } as IncomingMessage;
    handleModelsGet(req, res, {
      knownModels: cache.get,
      knownModelsFor: cache.getFor,
      config: config(),
      clients: new Set(),
    } as never);
    expect(body()).toMatchObject({ provider: "remote", models: [], loading: true });
  });

  it("keeps the active-provider shape when the query is absent", () => {
    const { res, body } = resStub();
    const req = { url: "/api/models" } as IncomingMessage;
    handleModelsGet(req, res, {
      knownModels: () => ["active-a"],
      knownModelsFor: () => ({ models: [], loading: false }),
      config: config(),
      clients: new Set(),
    } as never);
    expect(body()).toMatchObject({ models: ["active-a"] });
  });

  it("passes the active loading/error status through the wire", () => {
    const { res, body } = resStub();
    const req = { url: "/api/models" } as IncomingMessage;
    handleModelsGet(req, res, {
      knownModels: () => [],
      knownModelsState: () => ({ models: [], loading: false, error: true }),
      config: config(),
      clients: new Set(),
    } as never);
    expect(body()).toMatchObject({ models: [], loading: false, error: true });
  });

  it("retries a failed active list on the next GET", () => {
    const { res, body } = resStub();
    const refresh = vi.fn(async () => {});
    const req = { url: "/api/models" } as IncomingMessage;
    handleModelsGet(req, res, {
      knownModels: () => [],
      knownModelsState: () => ({ models: [], loading: false, error: true }),
      knownModelsRefresh: refresh,
      config: config(),
      clients: new Set(),
    } as never);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(body()).toMatchObject({ models: [], loading: true, error: false });
  });
});
