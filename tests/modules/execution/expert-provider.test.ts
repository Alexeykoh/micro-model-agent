import { describe, it, expect, vi } from "vitest";
import { resolveExpertProvider } from "../../../src/modules/execution/expert-provider";
import { DEFAULTS } from "../../../src/config/defaults";
import type { AppConfig } from "../../../src/config/types";
import type { LLMProvider } from "../../../src/llm/provider";

function cfg(): AppConfig {
  const c = structuredClone(DEFAULTS);
  c.model = "active-model";
  c.provider = { type: "openai-compat", baseUrl: "http://localhost:1234/v1" } as AppConfig["provider"];
  return c;
}

function activeProvider(): LLMProvider {
  return { chat: vi.fn(), countTokens: vi.fn() } as unknown as LLMProvider;
}

describe("resolveExpertProvider", () => {
  it("reuses the active provider when the expert model is unset", () => {
    const active = activeProvider();
    expect(resolveExpertProvider(cfg(), undefined, active)).toBe(active);
    expect(resolveExpertProvider(cfg(), "   ", active)).toBe(active);
  });

  it("reuses the active provider when the expert model matches the active model", () => {
    const active = activeProvider();
    expect(resolveExpertProvider(cfg(), "active-model", active)).toBe(active);
  });

  it("builds a dedicated provider when the expert model differs", () => {
    const active = activeProvider();
    const provider = resolveExpertProvider(cfg(), "expert-model", active);
    expect(provider).not.toBe(active);
    expect((provider as any).model).toBe("expert-model");
  });

  it("falls back to the active provider (fail-open) when the build throws", () => {
    const active = activeProvider();
    const c = cfg();
    // Non-empty entries with an unknown active name → ProviderManager.active throws.
    c.provider = {
      type: "openai-compat",
      baseUrl: "http://localhost:1234/v1",
      entries: [{ type: "openai-compat", label: "a", baseUrl: "http://localhost:1234/v1" }],
      active: "missing",
    } as AppConfig["provider"];
    const logger = { warn: vi.fn() } as any;
    expect(resolveExpertProvider(c, "expert-model", active, logger)).toBe(active);
    expect(logger.warn).toHaveBeenCalled();
  });

  // OpenCode Go/Zen отвечают 400 MissingSessionID без `x-opencode-session`:
  // заголовок шлётся только когда у провайдера есть getSessionId.
  it("forwards getSessionId to the dedicated provider", () => {
    const provider = resolveExpertProvider(
      cfg(),
      "expert-model",
      activeProvider(),
      undefined,
      () => "ses_expert",
    );
    expect((provider as any).getSessionId?.()).toBe("ses_expert");
  });

  it("builds the dedicated provider without a session getter when none is given", () => {
    const provider = resolveExpertProvider(cfg(), "expert-model", activeProvider());
    expect((provider as any).getSessionId?.()).toBeUndefined();
  });
});
