// Arch-гейт INV-P1: активная модель принадлежит активному провайдеру.
// Правило держится тремя точками, которые легко разойтись при рефакторинге:
// память моделей при свитче, boot/reconfigure-проверка и явный allowlist
// алиасов. Тест намеренно поведенческий: он падает, если любая точка
// перестанет выполнять инвариант, независимо от формы кода.
import { describe, it, expect, vi } from "vitest";
import { setConfigValue, setProviderMemoryApplier } from "../../src/config/registry";
import { syncProviderModelMemory } from "../../src/modules/providers/memory";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import {
  activeModelUnsupported,
  enforceActiveModel,
} from "../../src/modules/webui/settings/model-invariant";

function config(): AppConfig {
  const c = structuredClone(DEFAULTS);
  c.model = "model-a";
  c.provider = {
    type: "openai-compat",
    baseUrl: "http://a/v1",
    active: "a",
    models: { a: "model-a" },
    entries: [
      { type: "openai-compat", label: "a", baseUrl: "http://a/v1" },
      {
        type: "openai-compat",
        label: "b",
        baseUrl: "http://b/v1",
        unlistedModels: ["alias-b"],
      },
    ],
  };
  return c;
}

describe("INV-P1 gate", () => {
  it("a provider switch without memory clears the model instead of inheriting", () => {
    setProviderMemoryApplier(syncProviderModelMemory);
    try {
      const cfg = config();
      expect(setConfigValue(cfg, "provider.active", "b").ok).toBe(true);
      expect(cfg.model).toBe("");
    } finally {
      setProviderMemoryApplier(null);
    }
  });

  it("a switch restores the model remembered for that provider", () => {
    setProviderMemoryApplier(syncProviderModelMemory);
    try {
      const cfg = config();
      cfg.provider.models = { a: "model-a", b: "model-b" };
      expect(setConfigValue(cfg, "provider.active", "b").ok).toBe(true);
      expect(cfg.model).toBe("model-b");
    } finally {
      setProviderMemoryApplier(null);
    }
  });

  it("an unlisted model is cleared from a loaded provider list", async () => {
    const cfg = config();
    const reconfigure = vi.fn();
    const changed = await enforceActiveModel(
      { saveConfig: vi.fn() },
      { reconfigure },
      cfg,
      { models: ["other"], loading: false },
    );
    expect(changed).toBe(true);
    expect(cfg.model).toBe("");
    expect(cfg.provider.models?.a).toBeUndefined();
    expect(reconfigure).toHaveBeenCalledWith(cfg, { probe: false });
  });

  it("fails open while the list is loading, failed or empty", () => {
    for (const view of [
      { models: [], loading: true },
      { models: [], loading: false, error: true },
      { models: [], loading: false },
      undefined,
    ]) {
      expect(activeModelUnsupported(config(), view)).toBe(false);
    }
  });

  it("keeps an alias explicitly allowed by the provider entry", () => {
    const cfg = config();
    cfg.provider.active = "b";
    cfg.model = "alias-b";
    expect(activeModelUnsupported(cfg, { models: ["other"], loading: false })).toBe(false);
  });

  it("resets a manual context window left without a model", async () => {
    const cfg = config();
    cfg.model = "";
    cfg.contextAuto = false;
    cfg.contextWindow = 1_000_000;
    const saveConfig = vi.fn();
    const changed = await enforceActiveModel(
      { saveConfig },
      { reconfigure: vi.fn() },
      cfg,
      { models: ["model-a"], loading: false },
    );
    expect(changed).toBe(true);
    expect(cfg.contextAuto).toBe(true);
    expect(cfg.contextWindow).toBe(DEFAULTS.contextWindow);
    expect(saveConfig).toHaveBeenCalledWith(cfg, "contextWindow");
  });
});
