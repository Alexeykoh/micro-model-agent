import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  ProviderManager,
  createProvider,
  defaultRegistry,
  BUILTIN_PROVIDERS,
  HOSTED_BASE_URLS,
} from "../src/modules/providers/index";

describe("providers module", () => {
  describe("registry", () => {
    it("registers and looks up specs by type", () => {
      const registry = new ProviderRegistry();
      registry.register({ type: "test", label: "Test", baseUrl: "", capabilities: {
        streaming: true, tools: true, vision: false, reasoningStrategy: "none",
        listModels: false, requiresKey: false,
      }, create: (opts) => ({ ...opts, model: opts.model, contextWindow: opts.contextWindow } as any) });

      expect(registry.get("test")?.label).toBe("Test");
      expect(registry.has("test")).toBe(true);
      expect(registry.has("missing")).toBe(false);
      expect(registry.types()).toContain("test");
    });

    it("default registry contains all builtin presets", () => {
      const registry = defaultRegistry();
      expect(registry.list()).toHaveLength(BUILTIN_PROVIDERS.length);
      for (const spec of BUILTIN_PROVIDERS) {
        expect(registry.get(spec.type)).toBeDefined();
      }
    });
  });

  describe("createProvider", () => {
    it("builds an OpenAI-compatible provider", () => {
      const provider = createProvider("openai-compat", {
        model: "test-model",
        baseUrl: "http://localhost:1234/v1",
        contextWindow: 32768,
      });
      expect(provider.model).toBe("test-model");
      expect(provider.contextWindow).toBe(32768);
    });

    it("builds an OpenRouter provider with its preset base URL", () => {
      const provider = createProvider("openrouter", {
        model: "gpt-4o",
        baseUrl: "https://openrouter.ai/api/v1",
        contextWindow: 32768,
      });
      expect(provider.model).toBe("gpt-4o");
    });

    it("falls back to openai-compat for unknown types (backward compatible)", () => {
      const provider = createProvider("some-custom-type", {
        model: "m",
        baseUrl: "http://localhost:1234/v1",
        contextWindow: 32768,
      });
      expect(provider).toBeDefined();
      expect(provider.model).toBe("m");
    });

    it("forwards apiKey and rate limits to the provider", () => {
      const provider = createProvider("openai-compat", {
        model: "m",
        baseUrl: "http://localhost:1234/v1",
        apiKey: "sk-test",
        contextWindow: 32768,
        rateLimits: { maxRequestsPerMinute: 10, windowMs: 60000 },
      }) as any;
      expect(provider.config.apiKey).toBe("sk-test");
    });
  });

  describe("presets", () => {
    it("exposes hosted base URLs for hosted providers only", () => {
      expect(HOSTED_BASE_URLS["openrouter"]).toBe("https://openrouter.ai/api/v1");
      expect(HOSTED_BASE_URLS["opencode-zen"]).toBe("https://opencode.ai/zen/v1");
      expect(HOSTED_BASE_URLS["opencode-go"]).toBe("https://opencode.ai/zen/go/v1");
      expect(HOSTED_BASE_URLS["openai-compat"]).toBeUndefined(); // user-entered URL
    });

    it("flags the anthropic preset as non-OpenAI-compatible", () => {
      const anthropic = BUILTIN_PROVIDERS.find((p) => p.type === "anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic?.capabilities.streaming).toBe(false);
      expect(anthropic?.capabilities.tools).toBe(false);
      expect(anthropic?.capabilities.requiresKey).toBe(true);
    });
  });

  describe("ProviderManager", () => {
    const opts = { contextWindow: 32768 };

    it("normalizes a legacy single-provider config into one entry", () => {
      const m = new ProviderManager(
        { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
        opts,
      );
      expect(m.list()).toHaveLength(1);
      expect(m.activeName).toBe("openai-compat");
    });

    it("uses the active entry from multi-provider config", () => {
      const m = new ProviderManager(
        {
          active: "zen",
          entries: [
            { type: "openai-compat", label: "local", baseUrl: "http://localhost:1234/v1" },
            { type: "opencode-zen", label: "zen", baseUrl: "https://opencode.ai/zen/v1" },
          ],
        },
        opts,
      );
      expect(m.activeName).toBe("zen");
      expect(m.activeEntry.type).toBe("opencode-zen");
    });

    it("hot-swaps provider and rebuilds the active provider", () => {
      const m = new ProviderManager(
        {
          active: "local",
          entries: [
            { type: "openai-compat", label: "local", baseUrl: "http://localhost:1234/v1" },
            { type: "openrouter", label: "router", baseUrl: "https://openrouter.ai/api/v1" },
          ],
        },
        opts,
      );
      const first = m.setModel("qwen");
      expect(first.model).toBe("qwen");
      const swapped = m.switch("router");
      expect(m.activeName).toBe("router");
      expect(swapped.model).toBe("qwen");
      expect(m.activeEntry.baseUrl).toBe("https://openrouter.ai/api/v1");
    });

    it("changes model on the active provider", () => {
      const m = new ProviderManager(
        { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
        opts,
      );
      const p = m.setModel("model-a");
      expect(p.model).toBe("model-a");
      const p2 = m.setModel("model-b");
      expect(p2.model).toBe("model-b");
      expect(m.activeModel).toBe("model-b");
    });

    it("throws on unknown provider switch", () => {
      const m = new ProviderManager(
        { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
        opts,
      );
      expect(() => m.switch("nope")).toThrow(/Unknown provider/);
    });

    it("serializes back to config with active + entries + legacy fields", () => {
      const m = new ProviderManager(
        {
          active: "router",
          entries: [
            { type: "openai-compat", label: "local", baseUrl: "http://localhost:1234/v1" },
            { type: "openrouter", label: "router", baseUrl: "https://openrouter.ai/api/v1" },
          ],
        },
        opts,
      );
      const cfg = m.toConfig();
      expect(cfg.active).toBe("router");
      expect(cfg.entries).toHaveLength(2);
      expect(cfg.type).toBe("openrouter");
      expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    });
  });

  describe("per-entry isolation (Phase 4.3)", () => {
    const opts = { contextWindow: 32768 };

    it("builds each entry with its own apiKey, retry and rateLimits", () => {
      const registry = new ProviderRegistry();
      const captured: any[] = [];
      registry.register({
        type: "capturing",
        label: "Capturing",
        baseUrl: "",
        capabilities: {
          streaming: true, tools: true, vision: false, reasoningStrategy: "none",
          listModels: false, requiresKey: false,
        },
        create: (o) => {
          captured.push(o);
          return { model: o.model, contextWindow: o.contextWindow } as any;
        },
      });
      const m = new ProviderManager(
        {
          active: "a",
          entries: [
            {
              type: "capturing", label: "a", baseUrl: "http://a/v1",
              apiKey: "key-a", contextWindow: 8192,
              retry: { maxRetries: 1, baseDelay: 10, maxDelay: 20 },
              rateLimits: { maxRequestsPerMinute: 30, maxParallelTasks: 1 },
            },
            { type: "capturing", label: "b", baseUrl: "http://b/v1" },
          ],
        },
        { ...opts, registry },
      );
      void m.switch("a");
      void m.active;
      void m.switch("b");
      void m.active;
      expect(captured).toHaveLength(2);
      expect(captured[0].apiKey).toBe("key-a");
      expect(captured[0].contextWindow).toBe(8192);
      expect(captured[0].retry.maxRetries).toBe(1);
      expect(captured[0].rateLimits.maxRequestsPerMinute).toBe(30);
      // Entry b has none of its own → falls back to global options.
      expect(captured[1].apiKey).toBeUndefined();
      expect(captured[1].contextWindow).toBe(opts.contextWindow);
    });

    it("listNames orders entries by priority ascending (undefined last, stable)", () => {
      const m = new ProviderManager(
        {
          active: "local",
          entries: [
            { type: "openai-compat", label: "local", baseUrl: "http://l/v1" },
            { type: "openrouter", label: "router", baseUrl: "http://r/v1", priority: 1 },
            { type: "opencode-zen", label: "zen", baseUrl: "http://z/v1", priority: 0 },
            { type: "openai", label: "oai", baseUrl: "http://o/v1" },
          ],
        },
        opts,
      );
      expect(m.listNames()).toEqual(["zen", "router", "local", "oai"]);
    });

    it("toConfig preserves per-entry retry/rateLimits/priority", () => {
      const m = new ProviderManager(
        {
          active: "a",
          entries: [
            {
              type: "openai-compat", label: "a", baseUrl: "http://a/v1",
              priority: 2,
              rateLimits: { maxRequestsPerMinute: 10, maxParallelTasks: 2 },
            },
          ],
        },
        opts,
      );
      const cfg = m.toConfig();
      expect(cfg.entries![0].priority).toBe(2);
      expect(cfg.entries![0].rateLimits!.maxRequestsPerMinute).toBe(10);
    });

    it("pickFor returns the first capable entry by priority order", () => {
      const registry = new ProviderRegistry();
      const cap = (over: Partial<{ vision: boolean; tools: boolean; listModels: boolean }>) => ({
        streaming: true, tools: true, vision: false, reasoningStrategy: "none",
        listModels: false, requiresKey: false, ...over,
      });
      registry.register({
        type: "novision", label: "novision", baseUrl: "",
        capabilities: cap({}),
        create: (o) => ({ model: o.model, contextWindow: o.contextWindow } as any),
      });
      registry.register({
        type: "visionprov", label: "visionprov", baseUrl: "",
        capabilities: cap({ vision: true }),
        create: (o) => ({ model: o.model, contextWindow: o.contextWindow } as any),
      });
      const m = new ProviderManager(
        {
          active: "plain",
          entries: [
            { type: "novision", label: "plain", baseUrl: "http://p/v1" },
            { type: "visionprov", label: "vis", baseUrl: "http://v/v1", priority: -1 },
          ],
        },
        { ...opts, registry },
      );
      expect(m.pickFor({})).toBe("plain");
      expect(m.pickFor({ vision: true })).toBe("vis");
    });

    it("pickFor respects minContext against entry or global window", () => {
      const registry = defaultRegistry();
      const m = new ProviderManager(
        {
          active: "small",
          entries: [
            { type: "openai-compat", label: "small", baseUrl: "http://s/v1" },
            { type: "openai-compat", label: "big", baseUrl: "http://b/v1", contextWindow: 131072 },
          ],
        },
        { contextWindow: 32768, registry },
      );
      expect(m.pickFor({ minContext: 8192 })).toBe("small");
      expect(m.pickFor({ minContext: 65536 })).toBe("big");
      expect(m.pickFor({ minContext: 999999 })).toBeUndefined();
    });
  });
});