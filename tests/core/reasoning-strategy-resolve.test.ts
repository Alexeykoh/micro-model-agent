// W3.2/D1: механизм reasoning резолвится тем же трёхслойным приоритетом, что
// vision/tools (INV-R2), и доходит до экземпляра провайдера через его сборку.
import { describe, it, expect } from "vitest";
import { resolveModelCapabilities } from "../../src/modules/providers/capabilities";
import { ProviderRegistry } from "../../src/modules/providers/registry";
import { ProviderManager } from "../../src/modules/providers/manager";
import type { ProviderCapabilities } from "../../src/modules/providers/types";
import type { ReasoningStrategy } from "../../src/config/types";

describe("reasoning strategy resolves in three layers (W3.2/D1)", () => {
  const preset = { vision: false, tools: true, reasoningStrategy: "prompt-tag" as const };

  it("preset is the lowest layer", () => {
    expect(resolveModelCapabilities(preset, undefined, undefined).reasoningStrategy).toBe("prompt-tag");
  });

  it("the live probe beats the preset", () => {
    expect(
      resolveModelCapabilities(preset, { reasoningStrategy: "template-kwarg" }, undefined)
        .reasoningStrategy,
    ).toBe("template-kwarg");
  });

  it("the model override beats the probe and the preset", () => {
    expect(
      resolveModelCapabilities(
        preset,
        { reasoningStrategy: "template-kwarg" },
        { reasoningStrategy: "openai-effort" },
      ).reasoningStrategy,
    ).toBe("openai-effort");
  });

  it("the override beats the preset even without a probe", () => {
    expect(
      resolveModelCapabilities(preset, undefined, { reasoningStrategy: "none" }).reasoningStrategy,
    ).toBe("none");
  });

  it("with no preset and no layers the strategy stays unset", () => {
    expect(resolveModelCapabilities(undefined, undefined, undefined).reasoningStrategy).toBeUndefined();
  });

  it("does not mutate the preset", () => {
    resolveModelCapabilities(preset, undefined, { reasoningStrategy: "none" });
    expect(preset.reasoningStrategy).toBe("prompt-tag");
  });
});

describe("provider build injects the RESOLVED strategy (W3.2/D1)", () => {
  function registryCapturing(store: { seen?: ReasoningStrategy }): ProviderRegistry {
    const cap = (strategy: ReasoningStrategy): ProviderCapabilities => ({
      streaming: true,
      tools: true,
      vision: false,
      reasoningStrategy: strategy,
      listModels: false,
      requiresKey: false,
    });
    const registry = new ProviderRegistry();
    registry.register({
      type: "capsprov",
      label: "capsprov",
      baseUrl: "",
      capabilities: cap("prompt-tag"),
      // Экземпляр получает capabilities из опций сборки — фиксируем, что в них.
      create: (o) => {
        store.seen = o.capabilities?.reasoningStrategy;
        return { model: o.model, contextWindow: o.contextWindow ?? 0 };
      },
    } as never);
    return registry;
  }

  it("the model override reaches the provider, overriding the preset", () => {
    const store: { seen?: ReasoningStrategy } = {};
    const m = new ProviderManager(
      {
        active: "caps",
        entries: [{ type: "capsprov", label: "caps", baseUrl: "http://c/v1" }],
      },
      {
        contextWindow: 32768,
        registry: registryCapturing(store),
        modelCapabilities: { m1: { reasoningStrategy: "none" } },
      },
    );
    m.setModel("m1");
    void m.active;
    expect(store.seen).toBe("none");
  });

  it("without an override the preset is used", () => {
    const store: { seen?: ReasoningStrategy } = {};
    const m = new ProviderManager(
      {
        active: "caps",
        entries: [{ type: "capsprov", label: "caps", baseUrl: "http://c/v1" }],
      },
      { contextWindow: 32768, registry: registryCapturing(store) },
    );
    m.setModel("m1");
    void m.active;
    expect(store.seen).toBe("prompt-tag");
  });
});
