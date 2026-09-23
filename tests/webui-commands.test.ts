import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWebUiState,
  type WebUiState,
  type WebSessionManager,
} from "../src/modules/webui/state";
import { makeWebCommands } from "../src/modules/webui/commands";
import { MemoryStore } from "../src/modules/memory/store";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";
import type { SessionMeta } from "../src/modules/session/types";

function testConfig(): AppConfig {
  const config = structuredClone(DEFAULTS);
  config.model = "original-model";
  return config;
}

function meta(id: string, name: string, active: boolean): SessionMeta {
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

function fakeSessions(initial: SessionMeta[], activeId: string | null): WebSessionManager {
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

function makeHarness(): {
  state: WebUiState;
  config: AppConfig;
  lines: string[];
  saved: AppConfig[];
  reconfigures: () => number;
  run: (line: string) => Promise<void>;
} {
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

describe("webui slash commands", () => {
  it("/help lists the supported subset", async () => {
    const h = makeHarness();
    await h.run("/help");
    const joined = h.lines.join("\n");
    expect(joined).toContain("/config <key> [value]");
    expect(joined).toContain("/model list");
    expect(joined).toContain("/memory");
    expect(joined).toContain("/status");
  });

  it("/status reports model, provider, context, session and verbosity", async () => {
    const h = makeHarness();
    await h.run("/status");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("original-model");
    expect(h.lines[0]).toContain("32768 tok");
    expect(h.lines[0]).toContain("work (3 msgs)");
    expect(h.lines[0]).toContain(" · ");
  });

  it("/config <key> reads through the registry", async () => {
    const h = makeHarness();
    await h.run("/config model");
    expect(h.lines).toEqual(["model = original-model"]);
  });

  it("/config <key> <value> writes, persists and reconfigures", async () => {
    const h = makeHarness();
    await h.run("/config contextWindow 65536");
    expect(h.config.contextWindow).toBe(65536);
    expect(h.saved).toHaveLength(1);
    expect(h.reconfigures()).toBe(1);
    expect(h.lines).toEqual(["contextWindow = 65536 · saved"]);
  });

  it("/config accepts aliases", async () => {
    const h = makeHarness();
    await h.run("/config context.window 16384");
    expect(h.config.contextWindow).toBe(16384);
    expect(h.lines).toEqual(["contextWindow = 16384 · saved"]);
  });

  it("/config rejects an unknown key without throwing", async () => {
    const h = makeHarness();
    await h.run("/config not.a.key 1");
    expect(h.lines[0]).toContain("unknown key: not.a.key");
    expect(h.saved).toHaveLength(0);
  });

  it("/model use switches the model and reconfigures", async () => {
    const h = makeHarness();
    await h.run("/model use m2");
    expect(h.config.model).toBe("m2");
    expect(h.reconfigures()).toBe(1);
    expect(h.lines).toEqual(["model = m2 · saved"]);
  });

  it("/model list marks the current model", async () => {
    const h = makeHarness();
    h.state.knownModels = () => ["original-model", "m2"];
    await h.run("/model list");
    expect(h.lines).toContain("current: original-model");
    expect(h.lines).toContain("* original-model");
    expect(h.lines).toContain("  m2");
  });

  it("/provider use switches the active provider", async () => {
    const h = makeHarness();
    h.config.provider.entries = [
      { type: "openai-compat", label: "local" },
      { type: "openrouter", label: "remote" },
    ];
    h.config.provider.active = "local";
    await h.run("/provider use remote");
    expect(h.config.provider.active).toBe("remote");
    expect(h.reconfigures()).toBe(1);
    expect(h.lines).toEqual(["provider.active = remote · saved"]);
  });

  it("/provider list marks the active entry", async () => {
    const h = makeHarness();
    h.config.provider.entries = [
      { type: "openai-compat", label: "local" },
      { type: "openrouter", label: "remote" },
    ];
    h.config.provider.active = "remote";
    await h.run("/provider list");
    expect(h.lines).toContain("* remote (openrouter)");
    expect(h.lines).toContain("  local (openai-compat)");
  });

  it("unknown command emits a dim hint and never throws", async () => {
    const h = makeHarness();
    await h.run("/nope");
    expect(h.lines).toEqual(["↳ unknown command: nope"]);
  });

  it("non-slash input is ignored", async () => {
    const h = makeHarness();
    await h.run("hello world");
    await h.run("");
    expect(h.lines).toHaveLength(0);
  });

  it("redacts credential-shaped output", async () => {
    const h = makeHarness();
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    await h.run(`/config model ${secret}`);
    expect(h.lines.join("\n")).not.toContain(secret);
    expect(h.lines.join("\n")).toContain("sk-[REDACTED]");
  });

  it("/memory reports unavailable without a store", async () => {
    const h = makeHarness();
    await h.run("/memory");
    expect(h.lines).toEqual(["↳ memory unavailable"]);
  });

  it("/memory set/get/overview operate on the shared store", async () => {
    const h = makeHarness();
    const dir = mkdtempSync(join(tmpdir(), "webui-mem-"));
    try {
      h.state.memory = new MemoryStore(dir);
      await h.run("/memory set name Alice");
      expect(h.lines).toEqual(["saved name=Alice"]);
      h.lines.length = 0;
      await h.run("/memory get name");
      expect(h.lines).toEqual(["name = Alice"]);
      h.lines.length = 0;
      await h.run("/memory");
      expect(h.lines.join("\n")).toContain("name = Alice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
