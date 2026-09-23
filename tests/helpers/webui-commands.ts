import { createWebUiState, type WebUiState, type WebSessionManager } from "../../src/modules/webui/state";
import { makeWebCommands } from "../../src/modules/webui/commands";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import type { SessionMeta } from "../../src/modules/session/types";

export function testConfig(): AppConfig {
  const config = structuredClone(DEFAULTS);
  config.model = "original-model";
  return config;
}

export function meta(id: string, name: string, active: boolean): SessionMeta {
  return {
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    messageCount: active ? 3 : 1,
    model: "m",
    contextWindow: 32768,
    projectDir: "/tmp",
  };
}

export function fakeSessions(initial: SessionMeta[], activeId: string | null): WebSessionManager {
  const store = new Map(initial.map((m) => [m.id, m]));
  let active = activeId;
  return {
    list: () => [...store.values()],
    get: (id) => store.get(id) ?? null,
    getActive: () => active,
    setActive: (id) => {
      if (!store.has(id)) throw new Error("not found");
      active = id;
    },
    delete: (id) => {
      if (!store.has(id)) throw new Error("not found");
      store.delete(id);
      if (active === id) active = null;
    },
  };
}

export interface CommandHarness {
  state: WebUiState;
  config: AppConfig;
  lines: string[];
  saved: AppConfig[];
  reconfigures: () => number;
  run: (line: string) => Promise<void>;
}

export function makeHarness(): CommandHarness {
  const state = createWebUiState();
  const config = testConfig();
  state.config = config;
  state.sessionManager = fakeSessions([meta("ses_1", "work", true)], "ses_1");
  state.knownModels = () => ["m1", "m2"];
  const saved: AppConfig[] = [];
  let reconfigures = 0;
  state.saveConfig = (cfg) => saved.push(cfg);
  state.reconfigure = () => {
    reconfigures++;
  };
  const lines: string[] = [];
  const run = makeWebCommands({ state, emit: (t) => lines.push(t) });
  return { state, config, lines, saved, reconfigures: () => reconfigures, run };
}
