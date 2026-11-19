import { describe, it, expect } from "vitest";
import { buildActiveProvider } from "../src/modules/providers/factory";
import { FallbackProvider } from "../src/modules/providers/fallback";

function cfg(over: Partial<Record<string, unknown>> = {}): any {
  return {
    version: "2.0.0",
    model: "test-model",
    contextWindow: 32768,
    provider: {
      type: "openai-compat",
      baseUrl: "http://default:1234/v1",
      fallback: true,
      active: "a",
      entries: [
        { type: "openai-compat", label: "a", baseUrl: "http://a:1234/v1" },
        { type: "openai-compat", label: "b", baseUrl: "http://b:1234/v1" },
      ],
    },
    ...over,
  };
}

describe("buildActiveProvider (B4)", () => {
  it("wraps the manager in FallbackProvider when fallback && entries > 1", () => {
    const { manager, provider } = buildActiveProvider(cfg());
    expect(provider).toBeInstanceOf(FallbackProvider);
    expect(manager.activeName).toBe("a");
  });

  it("does NOT wrap when fallback is off", () => {
    const { provider } = buildActiveProvider(
      cfg({ provider: { ...cfg().provider, fallback: false } }),
    );
    expect(provider).not.toBeInstanceOf(FallbackProvider);
  });

  it("does NOT wrap a single-entry config even with fallback on", () => {
    const { provider } = buildActiveProvider(
      cfg({
        provider: {
          ...cfg().provider,
          entries: [cfg().provider.entries[0]],
        },
      }),
    );
    expect(provider).not.toBeInstanceOf(FallbackProvider);
  });

  it("still routes through the ACTIVE entry after build (hot-swap uses factory)", () => {
    const { manager, provider } = buildActiveProvider(cfg());
    manager.switch("b");
    // The wrapper reads manager.active live, so a switch stays covered.
    expect(manager.activeName).toBe("b");
    expect(provider.model).toBe(manager.active.model);
  });
});