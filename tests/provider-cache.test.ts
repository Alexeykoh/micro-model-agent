import { describe, it, expect } from "vitest";
import {
  BUILTIN_PROVIDERS,
  ProviderManager,
  ProviderRegistry,
  resolveCacheCapability,
  NO_CACHE_CAPABILITY,
} from "../src/modules/providers/index";

function spec(type: string) {
  const s = BUILTIN_PROVIDERS.find((p) => p.type === type);
  if (!s) throw new Error(`missing preset ${type}`);
  return s;
}

describe("prompt-cache capability (Phase 0)", () => {
  describe("preset defaults", () => {
    it("marks local openai-compat as local caching reporting OpenAI fields", () => {
      const cache = spec("openai-compat").capabilities.cache;
      expect(cache?.mechanism).toBe("local");
      expect(cache?.report).toBe("openai");
      expect(cache?.requestCachePrompt).toBe(false);
      expect(cache?.sessionHeader).toBe(false);
    });

    it("OpenCode Zen/Go use the session header", () => {
      for (const type of ["opencode-zen", "opencode-go"]) {
        const cache = spec(type).capabilities.cache;
        expect(cache?.mechanism).toBe("auto");
        expect(cache?.report).toBe("openai");
        expect(cache?.sessionHeader).toBe(true);
      }
    });

    it("OpenRouter sets session_id and OpenAI sets prompt_cache_key", () => {
      expect(spec("openrouter").capabilities.cache?.requestSessionId).toBe(true);
      expect(spec("openai").capabilities.cache?.requestPromptCacheKey).toBe(true);
    });

    it("Anthropic is explicit with cache_control and its own report format", () => {
      const cache = spec("anthropic").capabilities.cache;
      expect(cache?.mechanism).toBe("explicit");
      expect(cache?.report).toBe("anthropic");
      expect(cache?.requestCacheControl).toBe(true);
    });
  });

  describe("resolveCacheCapability", () => {
    it("falls back to NO_CACHE for an unknown provider", () => {
      expect(resolveCacheCapability(undefined)).toEqual(NO_CACHE_CAPABILITY);
    });

    it("returns the preset capability unchanged without an override", () => {
      expect(resolveCacheCapability(spec("openai"))).toEqual(
        spec("openai").capabilities.cache,
      );
    });

    it("merges a partial override over the preset", () => {
      const merged = resolveCacheCapability(spec("openai-compat"), {
        requestCachePrompt: true,
        mechanism: "auto",
      });
      expect(merged.requestCachePrompt).toBe(true);
      expect(merged.mechanism).toBe("auto");
      // незатронутые поля сохраняют значения пресета
      expect(merged.report).toBe("openai");
    });

    it("returns a fresh object (no shared-state mutation)", () => {
      const a = resolveCacheCapability(undefined);
      a.report = "openai";
      expect(NO_CACHE_CAPABILITY.report).toBe("none");
      expect(resolveCacheCapability(undefined).report).toBe("none");
    });
  });

  describe("ProviderManager forwards resolved capabilities", () => {
    it("passes preset cache + per-entry override to the factory", () => {
      const registry = new ProviderRegistry();
      const captured: any[] = [];
      registry.register({
        type: "openai-compat",
        label: "local",
        baseUrl: "",
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          reasoningStrategy: "none",
          listModels: true,
          requiresKey: false,
          cache: NO_CACHE_CAPABILITY,
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
            { type: "openai-compat", label: "a", baseUrl: "http://a/v1" },
          ],
        },
        { contextWindow: 32768, registry },
      );
      void m.active;
      expect(captured[0].capabilities.cache).toEqual(NO_CACHE_CAPABILITY);
    });

    it("entry.cache overrides the preset default", () => {
      const registry = new ProviderRegistry();
      const seen: any[] = [];
      const base = BUILTIN_PROVIDERS.find((p) => p.type === "openai")!;
      // Приватная копия, чтобы не мутировать общий builtin-спек.
      registry.register({
        ...base,
        capabilities: { ...base.capabilities, cache: { ...base.capabilities.cache! } },
        create: (o) => {
          seen.push(o);
          return { model: o.model, contextWindow: o.contextWindow } as any;
        },
      });
      const m = new ProviderManager(
        {
          active: "oai",
          entries: [
            {
              type: "openai",
              label: "oai",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-test",
              cache: { requestCachePrompt: true },
            },
          ],
        },
        { contextWindow: 32768, registry },
      );
      void m.setModel("gpt-5");
      expect(seen[0].capabilities.cache.requestCachePrompt).toBe(true);
      expect(seen[0].capabilities.cache.requestPromptCacheKey).toBe(true);
    });
  });
});
