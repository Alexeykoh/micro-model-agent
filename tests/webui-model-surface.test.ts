// Boot-проводка списка моделей: после первого списка клиенты обязаны получить
// `models` (иначе панель навсегда остаётся на «загрузке»), а модель, которой у
// провайдера нет, — сброшена с событием `config` (INV-P1).
import { describe, it, expect, vi } from "vitest";
import { installModelSurface } from "../src/modules/webui/settings/model-surface";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";

function cfg(model: string): AppConfig {
  return { ...structuredClone(DEFAULTS), model } as AppConfig;
}

function stateStub(runner?: { agent: { reconfigure: ReturnType<typeof vi.fn> } }) {
  const events: string[] = [];
  const clients = new Set([
    {
      write: (payload: string) => {
        events.push(payload);
        return true;
      },
      end: () => {},
    },
  ]);
  return {
    events,
    state: {
      clients: clients as never,
      saveConfig: vi.fn(),
      usage: {},
      sessionUsage: {},
      pool: {
        runnerIds: () => (runner ? ["r1"] : []),
        getRunner: () => runner ?? null,
      },
    } as never,
  };
}

function agentStub(models: string[]) {
  return {
    getProviderFor: () => ({ listModels: async () => models }),
    reconfigure: vi.fn(),
    contextManager: { getBudget: () => ({ history: 1 }) },
  } as never;
}

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("installModelSurface (boot)", () => {
  it("broadcasts the model list so an open panel stops loading", async () => {
    const { state, events } = stateStub();
    installModelSurface(state, agentStub(["a", "b"]), cfg("a"));
    await flush();
    expect(events.some((e) => e.includes("event: models"))).toBe(true);
    // Модель подтверждена списком — конфиг не трогаем.
    expect(events.some((e) => e.includes("event: config"))).toBe(false);
  });

  it("clears a model the provider no longer offers and broadcasts config", async () => {
    const { state, events } = stateStub();
    const config = cfg("gone");
    installModelSurface(state, agentStub(["a"]), config);
    await flush();
    expect(config.model).toBe("");
    expect(events.some((e) => e.includes("event: models"))).toBe(true);
    expect(events.some((e) => e.includes("event: config"))).toBe(true);
  });

  it("does not refresh when an explicit model source is wired", async () => {
    const { state, events } = stateStub();
    const known = () => ["external"];
    installModelSurface(state, agentStub(["a"]), cfg("a"), known);
    await flush();
    expect(events).toEqual([]);
  });

  it("reconfigures live runners when the model is cleared", async () => {
    const reconfigure = vi.fn();
    const { state } = stateStub({ agent: { reconfigure } });
    const config = cfg("gone");
    installModelSurface(state, agentStub(["a"]), config);
    await flush();
    expect(reconfigure).toHaveBeenCalledWith(config, { probe: false });
  });

  it("re-validates on an explicit refresh (retry path)", async () => {
    const { state, events } = stateStub();
    const config = cfg("a");
    installModelSurface(state, agentStub(["a"]), config);
    await flush();
    events.length = 0;
    // Модель изменилась мимо reconfigure — следующий refresh обязан её проверить.
    config.model = "gone";
    await (state as unknown as { knownModelsRefresh: () => Promise<void> }).knownModelsRefresh();
    expect(config.model).toBe("");
    expect(events.some((e) => e.includes("event: models"))).toBe(true);
    expect(events.some((e) => e.includes("event: config"))).toBe(true);
  });
});
