/**
 * P1: выбор провайдера — данные пользователя, а рантайм-переключение (health-probe,
 * failover) — состояние сессии. `ProviderManager` не должен алиасить живой
 * `config.provider`: `switch()` писал в него `active`, из-за чего фоновый probe
 * всех entries менял выбранного провайдера, а следующее сохранение конфига
 * персистило подмену.
 */
import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { ProviderManager } from "../../src/modules/providers/manager";
import { getProviderFor, type ProviderPhaseHost } from "../../src/core/agent/provider-phase";

function makeConfig(): AppConfig {
  const config = structuredClone(DEFAULTS);
  config.model = "m1";
  config.contextWindow = 8000;
  config.provider = {
    active: "alpha",
    type: "openai-compat",
    baseUrl: "http://alpha/v1",
    apiKey: "k",
    entries: [
      { type: "openai-compat", label: "alpha", baseUrl: "http://alpha/v1", apiKey: "k" },
      { type: "openai-compat", label: "beta", baseUrl: "http://beta/v1", apiKey: "k" },
    ],
  };
  return config;
}

function makeHost(config: AppConfig): ProviderPhaseHost {
  const logger = {
    warn: () => {},
    info: () => {},
    debug: () => {},
    logSilent: () => {},
  };
  return {
    deps: { config, logger },
    costTracker: {},
    lastProbeIdentity: { model: "", baseUrl: "" },
    probePassed: false,
  } as unknown as ProviderPhaseHost;
}

describe("provider selection purity (P1)", () => {
  it("manager.switch does not rewrite the configured active provider", () => {
    const config = makeConfig();
    const manager = new ProviderManager(config.provider, { contextWindow: config.contextWindow });
    manager.setModel(config.model);

    manager.switch("beta");

    expect(manager.activeName).toBe("beta");
    expect(config.provider.active).toBe("alpha");
    // Явный путь сохранения по-прежнему отдаёт новое состояние.
    expect(manager.toConfig().active).toBe("beta");
  });

  it("getProviderFor (health-probe path) does not rewrite config.provider.active", () => {
    const config = makeConfig();
    const provider = getProviderFor(makeHost(config), "beta");

    expect(provider).toBeDefined();
    expect(provider?.model).toBe("m1");
    expect(config.provider.active).toBe("alpha");
  });

  it("a probe of every entry leaves the selection intact (REPL startup scenario)", () => {
    const config = makeConfig();
    const host = makeHost(config);

    for (const entry of config.provider.entries ?? []) {
      getProviderFor(host, entry.label ?? entry.type);
    }

    expect(config.provider.active).toBe("alpha");
  });
});
