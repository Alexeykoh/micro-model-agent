// INV-P1: активная модель обязана принадлежать активному провайдеру. Список
// приходит асинхронно, поэтому проверка живёт рядом с фоновым refresh'ем:
// пока список грузится или провайдер не ответил — ничего не сбрасываем
// (fail-open), а как только получен непустой список без модели — очищаем.
import { describe, it, expect, vi } from "vitest";
import {
  activeModelUnsupported,
  enforceActiveModel,
} from "../src/modules/webui/settings/model-invariant";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  const c = structuredClone(DEFAULTS);
  return {
    ...c,
    model: "qwen3.8-27b",
    provider: {
      ...c.provider,
      active: "opencode-go",
      models: { "opencode-go": "qwen3.8-27b" },
    },
    ...over,
  } as AppConfig;
}

const READY = { models: ["iceman-contributor-free"], loading: false } as const;

describe("activeModelUnsupported", () => {
  it("flags a model missing from a loaded provider list", () => {
    expect(activeModelUnsupported(cfg(), READY)).toBe(true);
  });

  it("accepts a model present in the list", () => {
    expect(activeModelUnsupported(cfg({ model: "iceman-contributor-free" }), READY)).toBe(false);
  });

  it("does not judge while the list is loading or failed", () => {
    expect(activeModelUnsupported(cfg(), { models: [], loading: true })).toBe(false);
    expect(activeModelUnsupported(cfg(), { models: [], loading: false, error: true })).toBe(false);
    expect(activeModelUnsupported(cfg(), { models: [], loading: false })).toBe(false);
    expect(activeModelUnsupported(cfg(), undefined)).toBe(false);
  });

  it("ignores the empty model (nothing to revoke)", () => {
    expect(activeModelUnsupported(cfg({ model: "" }), READY)).toBe(false);
  });
});

describe("enforceActiveModel", () => {
  it("clears the unsupported model, its memory and reconfigures offline", async () => {
    const config = cfg();
    const saveConfig = vi.fn();
    const reconfigure = vi.fn();
    const changed = await enforceActiveModel({ saveConfig }, { reconfigure }, config, READY);
    expect(changed).toBe(true);
    expect(config.model).toBe("");
    expect(config.provider.models?.["opencode-go"]).toBeUndefined();
    // Очистка должна пережить рестарт: `model` и память провайдера — разные домены.
    expect(saveConfig).toHaveBeenCalledWith(config, "model");
    expect(saveConfig).toHaveBeenCalledWith(config, "provider.active");
    expect(reconfigure).toHaveBeenCalledWith(config, { probe: false });
  });

  it("does nothing on a loading, failed or empty list", async () => {
    for (const view of [
      { models: [], loading: true },
      { models: [], loading: false, error: true },
      { models: [], loading: false },
    ]) {
      const config = cfg();
      const saveConfig = vi.fn();
      const reconfigure = vi.fn();
      const changed = await enforceActiveModel({ saveConfig }, { reconfigure }, config, view);
      expect(changed).toBe(false);
      expect(config.model).toBe("qwen3.8-27b");
      expect(saveConfig).not.toHaveBeenCalled();
      expect(reconfigure).not.toHaveBeenCalled();
    }
  });

  it("keeps the config applied even if persisting throws", async () => {
    const config = cfg();
    const saveConfig = vi.fn(() => {
      throw new Error("disk full");
    });
    const reconfigure = vi.fn();
    const changed = await enforceActiveModel({ saveConfig }, { reconfigure }, config, READY);
    expect(changed).toBe(true);
    expect(config.model).toBe("");
    expect(reconfigure).toHaveBeenCalled();
  });
});
