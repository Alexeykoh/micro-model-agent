import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { probeProviderContext } from "../../src/llm/model-loader";
import { lookupModelsDevContext, resetModelsDevCache } from "../../src/llm/models-dev";

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = handler(String(url), init);
    if (body instanceof Error) throw body;
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => body };
  }) as any;
}

describe("probeProviderContext", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("prefers the actually loaded instance over the model card maximum (LM Studio)", async () => {
    mockFetch((url) =>
      String(url).endsWith("/api/v1/models")
        ? {
            models: [
              {
                key: "qwen/qwen3.5-9b",
                max_context_length: 131072,
                loaded_instances: [{ config: { context_length: 34048 } }],
              },
            ],
          }
        : null,
    );
    const probe = await probeProviderContext("http://localhost:1234/v1", "qwen/qwen3.5-9b");
    expect(probe).toEqual({ model: "qwen/qwen3.5-9b", actual: 34048 });
  });

  it("reads OpenRouter-style context_length from /models", async () => {
    mockFetch((url) =>
      String(url).endsWith("/v1/models")
        ? { data: [{ id: "deepseek/deepseek-v4.1-flash", context_length: 131072 }] }
        : null,
    );
    const probe = await probeProviderContext(
      "https://openrouter.ai/api/v1",
      "deepseek/deepseek-v4.1-flash",
      { apiKey: "k" },
    );
    expect(probe).toEqual({ model: "deepseek/deepseek-v4.1-flash", actual: 131072 });
  });

  it("falls back to top_provider.context_length when the top level has none", async () => {
    mockFetch((url) =>
      String(url).endsWith("/v1/models")
        ? {
            data: [
              { id: "x/y", top_provider: { context_length: 65536, is_moderated: true } },
            ],
          }
        : null,
    );
    const probe = await probeProviderContext("https://openrouter.ai/api/v1", "x/y");
    expect(probe).toEqual({ model: "x/y", actual: 65536 });
  });

  it("reads Ollama /api/show model_info when /api/ps carries no context", async () => {
    mockFetch((url, init) => {
      if (String(url).endsWith("/api/v1/models")) return { models: [] };
      if (String(url).endsWith("/api/ps"))
        return { models: [{ name: "qwen3:8b", model: "qwen3:8b", size: 1 }] };
      if (String(url).endsWith("/api/show") && init?.method === "POST")
        return { model_info: { "llama.context_length": 40960 } };
      return null;
    });
    const probe = await probeProviderContext("http://localhost:11434/v1", "qwen3:8b");
    expect(probe).toEqual({ model: "qwen3:8b", actual: 40960 });
  });

  it("reads llama.cpp /props n_ctx", async () => {
    mockFetch((url) => {
      if (String(url).endsWith("/api/v1/models")) return { models: [] };
      if (String(url).endsWith("/api/ps")) return null;
      if (String(url).endsWith("/props")) return { n_ctx: 16384 };
      return null;
    });
    const probe = await probeProviderContext("http://localhost:8080/v1", "any-model");
    expect(probe).toEqual({ model: "any-model", actual: 16384 });
  });

  it("reads vLLM-style max_model_len from /models", async () => {
    mockFetch((url) =>
      String(url).endsWith("/v1/models")
        ? { data: [{ id: "Qwen/Qwen3-Coder-30B", owned_by: "vllm", max_model_len: 262144 }] }
        : null,
    );
    const probe = await probeProviderContext("http://localhost:8000/v1", "Qwen/Qwen3-Coder-30B");
    expect(probe).toEqual({ model: "Qwen/Qwen3-Coder-30B", actual: 262144 });
  });

  it("returns null for bare OpenAI-style id-only /models", async () => {
    mockFetch((url) => {
      if (String(url).endsWith("/api/v1/models")) return { models: [] };
      if (String(url).endsWith("/api/ps")) return null;
      if (String(url).endsWith("/props")) return null;
      if (String(url).endsWith("/v1/models")) return { data: [{ id: "gpt-x" }] };
      return null;
    });
    expect(await probeProviderContext("https://api.openai.com/v1", "gpt-x")).toBeNull();
  });

  it("returns null when the model is not reported anywhere", async () => {
    mockFetch((url) =>
      String(url).endsWith("/v1/models")
        ? { data: [{ id: "other", context_length: 8192 }] }
        : null,
    );
    expect(await probeProviderContext("https://example.com/v1", "missing")).toBeNull();
  });

  it("fails open when the network throws", async () => {
    mockFetch(() => new Error("down"));
    expect(await probeProviderContext("http://localhost:1234/v1", "m")).toBeNull();
  });
});

const ZEN_CATALOG = {
  opencode: {
    models: {
      "deepseek-v4.1-flash": { limit: { context: 1000000 } },
    },
  },
};

/** Provider endpoints return bare shapes (no context anywhere) by default. */
function mockBareProvider(handler?: (url: string) => unknown) {
  mockFetch((url) => {
    if (handler) {
      const extra = handler(String(url));
      if (extra !== undefined) return extra;
    }
    if (String(url).endsWith("/api/v1/models")) return { models: [] };
    if (String(url).endsWith("/v1/models")) return { data: [{ id: "deepseek-v4.1-flash" }] };
    return null;
  });
}

describe("probeProviderContext models.dev fallback", () => {
  let originalFetch: typeof global.fetch;
  let originalCache: string | undefined;
  let cacheFile: string;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalCache = process.env.MMA_MODELS_DEV_CACHE;
    cacheFile = join(mkdtempSync(join(tmpdir(), "mma-models-dev-")), "cache.json");
    process.env.MMA_MODELS_DEV_CACHE = cacheFile;
    resetModelsDevCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetModelsDevCache();
    if (originalCache === undefined) delete process.env.MMA_MODELS_DEV_CACHE;
    else process.env.MMA_MODELS_DEV_CACHE = originalCache;
  });

  it("resolves Zen bare ids via the models.dev catalog", async () => {
    mockBareProvider((url) =>
      url === "https://models.dev/api.json" ? ZEN_CATALOG : undefined,
    );
    const probe = await probeProviderContext(
      "https://opencode.ai/zen/go/v1",
      "deepseek-v4.1-flash",
      { providerType: "opencode-go" },
    );
    expect(probe).toEqual({ model: "deepseek-v4.1-flash", actual: 1000000 });
  });

  it("sniffs the Zen URL even without a provider type", async () => {
    mockBareProvider((url) =>
      url === "https://models.dev/api.json" ? ZEN_CATALOG : undefined,
    );
    const probe = await probeProviderContext(
      "https://opencode.ai/zen/v1",
      "deepseek-v4.1-flash",
    );
    expect(probe).toEqual({ model: "deepseek-v4.1-flash", actual: 1000000 });
  });

  it("never touches models.dev for local backends", async () => {
    const seen: string[] = [];
    global.fetch = (async (url: unknown) => {
      seen.push(String(url));
      return { ok: false, status: 404, json: async () => ({}) };
    }) as any;
    expect(await probeProviderContext("http://localhost:1234/v1", "m")).toBeNull();
    expect(seen.some((u) => u.includes("models.dev"))).toBe(false);
  });

  it("returns null for unknown model ids (catalog still caches)", async () => {
    mockBareProvider((url) =>
      url === "https://models.dev/api.json" ? ZEN_CATALOG : undefined,
    );
    expect(
      await probeProviderContext("https://opencode.ai/zen/go/v1", "nope", {
        providerType: "opencode-go",
      }),
    ).toBeNull();
    // Catalog was fetched and cached despite the miss.
    resetModelsDevCache();
    global.fetch = (() => {
      throw new Error("must serve from disk cache");
    }) as any;
    expect(await lookupModelsDevContext("deepseek-v4.1-flash")).toBe(1000000);
  });
});

describe("lookupModelsDevContext cache", () => {
  let originalFetch: typeof global.fetch;
  let originalCache: string | undefined;
  let cacheFile: string;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalCache = process.env.MMA_MODELS_DEV_CACHE;
    cacheFile = join(mkdtempSync(join(tmpdir(), "mma-models-dev-")), "cache.json");
    process.env.MMA_MODELS_DEV_CACHE = cacheFile;
    resetModelsDevCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetModelsDevCache();
    if (originalCache === undefined) delete process.env.MMA_MODELS_DEV_CACHE;
    else process.env.MMA_MODELS_DEV_CACHE = originalCache;
  });

  it("serves the second lookup from cache without network", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return { ok: true, json: async () => ZEN_CATALOG };
    }) as any;
    expect(await lookupModelsDevContext("deepseek-v4.1-flash")).toBe(1000000);
    resetModelsDevCache();
    global.fetch = (() => {
      throw new Error("offline");
    }) as any;
    expect(await lookupModelsDevContext("deepseek-v4.1-flash")).toBe(1000000);
    expect(calls).toBe(1);
  });

  it("refetches on a corrupt disk cache", async () => {
    writeFileSync(cacheFile, "not-json{{{", "utf-8");
    global.fetch = (async () => ({
      ok: true,
      json: async () => ZEN_CATALOG,
    })) as any;
    expect(await lookupModelsDevContext("deepseek-v4.1-flash")).toBe(1000000);
  });

  it("returns null when the catalog has no opencode section", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ other: { models: {} } }),
    })) as any;
    expect(await lookupModelsDevContext("deepseek-v4.1-flash")).toBeNull();
  });
});
