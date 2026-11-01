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

function cfgWithEntries(): AppConfig {
  const c = cfg();
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

function activeProvider(): LLMProvider {
  return { chat: vi.fn(), countTokens: vi.fn() } as unknown as LLMProvider;
}

/**
 * baseUrl собранного провайдера. `ProviderManager.active` может быть обёрнут
 * в `SanitizingProvider` (data-policy egress) — в полном прогоне гвард уже
 * включён другим тестом, поэтому разворачиваем обёртки до реального клиента.
 */
function baseUrlOf(provider: unknown): string {
  let cur = provider as
    | { config?: { baseUrl?: string }; inner?: unknown; source?: { active?: unknown } }
    | undefined;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur.config?.baseUrl === "string") return cur.config.baseUrl;
    if (cur.inner) {
      cur = cur.inner as typeof cur;
      continue;
    }
    if (cur.source?.active) {
      cur = cur.source.active as typeof cur;
      continue;
    }
    break;
  }
  return "";
}

describe("resolveExpertProvider", () => {
  it("reuses the active provider when the expert model is unset", () => {
    const active = activeProvider();
    expect(resolveExpertProvider(cfg(), undefined, undefined, active)).toBe(active);
    expect(resolveExpertProvider(cfg(), "   ", undefined, active)).toBe(active);
  });

  it("ignores a provider without a model and warns (mute option, contract of critic.provider)", () => {
    const active = activeProvider();
    const logger = { warn: vi.fn() } as any;
    expect(resolveExpertProvider(cfgWithEntries(), undefined, "remote", active, logger)).toBe(active);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain("without an expert model");
  });

  it("reuses the active provider when the expert model matches the active model", () => {
    const active = activeProvider();
    expect(resolveExpertProvider(cfg(), "active-model", undefined, active)).toBe(active);
    // Explicitly naming the active entry is still "inherit".
    expect(resolveExpertProvider(cfgWithEntries(), "active-model", "local", active)).toBe(active);
  });

  it("builds a dedicated provider when the expert model differs", () => {
    const active = activeProvider();
    const provider = resolveExpertProvider(cfg(), "expert-model", undefined, active);
    expect(provider).not.toBe(active);
    expect((provider as any).model).toBe("expert-model");
  });

  it("builds on the selected provider entry, not the active one", () => {
    const active = activeProvider();
    const provider = resolveExpertProvider(cfgWithEntries(), "remote-model", "remote", active);
    expect(provider).not.toBe(active);
    expect((provider as any).model).toBe("remote-model");
    expect(String(baseUrlOf(provider))).toContain("remote.example");
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
    expect(resolveExpertProvider(c, "expert-model", undefined, active, logger)).toBe(active);
    expect(logger.warn).toHaveBeenCalled();
  });

  // OpenCode Go/Zen отвечают 400 MissingSessionID без `x-opencode-session`:
  // заголовок шлётся только когда у провайдера есть getSessionId.
  it("forwards getSessionId to the dedicated provider", () => {
    const provider = resolveExpertProvider(
      cfg(),
      "expert-model",
      undefined,
      activeProvider(),
      undefined,
      () => "ses_expert",
    );
    expect((provider as any).getSessionId?.()).toBe("ses_expert");
  });

  it("builds the dedicated provider without a session getter when none is given", () => {
    const provider = resolveExpertProvider(cfg(), "expert-model", undefined, activeProvider());
    expect((provider as any).getSessionId?.()).toBeUndefined();
  });
});
