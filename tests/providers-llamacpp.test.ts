// llama.cpp / llama-swap on localhost:8080 is a first-class preset, not just a
// hand-typed openai-compat entry: the type, URL and local cache behaviour ship
// with the product.
import { describe, it, expect } from "vitest";
import {
  BUILTIN_PROVIDERS,
  HOSTED_BASE_URLS,
  createProvider,
  defaultRegistry,
} from "../src/modules/providers/index";

describe("llama.cpp provider preset", () => {
  const preset = BUILTIN_PROVIDERS.find((p) => p.type === "llamacpp");

  it("is registered with the local llama-swap endpoint", () => {
    expect(defaultRegistry().get("llamacpp")).toBeDefined();
    expect(preset?.baseUrl).toBe("http://localhost:8080/v1");
    expect(HOSTED_BASE_URLS.llamacpp).toBe("http://localhost:8080/v1");
    expect(preset?.capabilities.requiresKey).toBe(false);
    expect(preset?.capabilities.listModels).toBe(true);
  });

  it("uses the local cache and streams usage in OpenAI form", () => {
    const cache = preset?.capabilities.cache;
    expect(cache?.mechanism).toBe("local");
    expect(cache?.report).toBe("openai");
    expect(cache?.requestStreamUsage).toBe(true);
    // `cache_prompt` trades determinism for reuse — opt-in per entry, not a preset default.
    expect(cache?.requestCachePrompt).toBe(false);
  });

  it("builds a working OpenAI-compatible provider", () => {
    const provider = createProvider("llamacpp", {
      model: "qwen3.8-27b-uncensored",
      baseUrl: "http://localhost:8080/v1",
      contextWindow: 64000,
    });
    expect(provider.model).toBe("qwen3.8-27b-uncensored");
    expect(provider.contextWindow).toBe(64000);
  });
});
