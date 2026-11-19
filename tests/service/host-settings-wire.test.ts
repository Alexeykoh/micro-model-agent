/**
 * W11: настройки и визард через host wire — провайдеры, MCP, память, плагины,
 * LSP и setup. Те же данные/валидация, что у локального веба.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import type { AgentServiceState } from "../../src/modules/service/state";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;
let base: string;
let state: AgentServiceState;
let sessionId: string;

function idleAgent() {
  return {
    async run(): Promise<AgentResult> {
      return { success: true, text: "ok", iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
    pause() {},
    resume() {},
  };
}

beforeEach(async () => {
  dir = tempServiceDir();
  const svc = startAgentService(makeServiceDeps({ dir, agent: idleAgent() }));
  stop = svc.stop;
  state = svc.state;
  base = await svc.url;
  sessionId = await firstSessionId(base);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

describe("providers over host wire (W11)", () => {
  it("lists, saves and refuses to delete the active provider", async () => {
    const list = await httpJson(`${base}/v1/host/providers`);
    expect(list.status).toBe(200);

    const saved = await httpJson(`${base}/v1/host/providers`, {
      method: "POST",
      json: { type: "openai", baseUrl: "http://localhost:1234/v1", label: "local" },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.ok).toBe(true);

    const active = state.config.provider.active || state.config.provider.type;
    const del = await httpJson(`${base}/v1/host/providers/${encodeURIComponent(active)}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(409);
    expect(del.json.error).toBe("active-provider");
  });
});

describe("mcp over host wire (W11)", () => {
  it("creates, toggles, updates and deletes a server", async () => {
    const created = await httpJson(`${base}/v1/host/mcp`, {
      method: "POST",
      json: { name: "fs", transport: "stdio", command: "mcp-fs" },
    });
    expect(created.status).toBe(200);
    expect(created.json.restartRequired).toBe(true);

    const list = await httpJson(`${base}/v1/host/mcp`);
    expect((list.json.mcp as Array<{ id: string }>).some((m) => m.id === "fs")).toBe(true);

    const toggled = await httpJson(`${base}/v1/host/mcp/fs`, {
      method: "POST",
      json: { enabled: false },
    });
    expect(toggled.status).toBe(200);
    expect(state.config.mcpServers?.fs?.enabled).toBe(false);

    const updated = await httpJson(`${base}/v1/host/mcp/fs`, {
      method: "PUT",
      json: { timeout: 30000 },
    });
    expect(updated.status).toBe(200);
    expect(state.config.mcpServers?.fs?.timeout).toBe(30000);

    const removed = await httpJson(`${base}/v1/host/mcp/fs`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(state.config.mcpServers?.fs).toBeUndefined();
  });

  it("reports a missing record as 404", async () => {
    const res = await httpJson(`${base}/v1/host/mcp/nope`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("memory over host wire (W11)", () => {
  it("appends and deletes an entry", async () => {
    const entries: string[] = [];
    state.deps.memory = {
      getPreferences: () => ({}),
      read: () => entries.join("\n"),
      append: (_c: string, text: string) => entries.push(text),
      deleteEntry: (_c: string, n: number) => {
        if (n < 1 || n > entries.length) return false;
        entries.splice(n - 1, 1);
        return true;
      },
    } as never;

    const added = await httpJson(`${base}/v1/host/memory`, {
      method: "POST",
      json: { category: "facts", text: "hello" },
    });
    expect(added.status).toBe(200);
    expect(entries).toEqual(["hello"]);

    const bad = await httpJson(`${base}/v1/host/memory`, {
      method: "POST",
      json: { category: "nope", text: "x" },
    });
    expect(bad.status).toBe(400);

    const del = await httpJson(`${base}/v1/host/memory/facts/1`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(entries).toEqual([]);
  });
});

describe("plugins over host wire (W11)", () => {
  it("toggles a plugin and reloads catalogs", async () => {
    const set: Array<[string, boolean]> = [];
    state.deps.plugins = {
      getRecords: () => [{ name: "p1", system: false }],
      getFailures: () => [],
      getPlugin: () => null,
      setEnabled: (name: string, on: boolean) => {
        set.push([name, on]);
        return true;
      },
      reload: () => ({ loaded: 0, staleTs: 0 }),
    } as never;

    const toggled = await httpJson(`${base}/v1/host/plugins/p1`, {
      method: "POST",
      json: { enabled: false },
    });
    expect(toggled.status).toBe(200);
    expect(set).toEqual([["p1", false]]);
    expect(state.config.plugins?.disabled).toContain("p1");

    const reload = await httpJson(`${base}/v1/host/reload/plugins`, { method: "POST" });
    expect(reload.status).toBe(200);
    expect(reload.json.ok).toBe(true);
  });

  it("rejects a missing plugin and hides system disable", async () => {
    state.deps.plugins = {
      getRecords: () => [{ name: "sys", system: true }],
      getFailures: () => [],
      getPlugin: () => null,
      setEnabled: () => true,
      reload: () => ({}),
    } as never;

    const missing = await httpJson(`${base}/v1/host/plugins/nope`, {
      method: "POST",
      json: { enabled: true },
    });
    expect(missing.status).toBe(404);

    const sys = await httpJson(`${base}/v1/host/plugins/sys`, {
      method: "POST",
      json: { enabled: false },
    });
    expect(sys.status).toBe(409);
  });
});

describe("lsp over host wire (W11)", () => {
  it("serves the server table, updates a server and checks a file", async () => {
    const servers = await httpJson(`${base}/v1/host/lsp`);
    expect(servers.status).toBe(200);
    expect(Array.isArray(servers.json.servers)).toBe(true);

    const updated = await httpJson(`${base}/v1/host/lsp/typescript`, {
      method: "PUT",
      json: { timeout: 20000 },
    });
    expect(updated.status).toBe(200);
    expect(updated.json.restartRequired).toBe(true);

    state.deps.lsp = {
      getFlags: () => ({ enabled: true, offline: false }),
      checkFileForWeb: async () => ({ ok: true, diagnostics: [] }),
      checkChangedForWeb: async () => ({ ok: true, files: [] }),
      diagnose: async () => ({ ok: true, servers: [] }),
    } as never;

    const check = await httpJson(`${base}/v1/host/lsp/check`, {
      method: "POST",
      json: { path: "a.ts" },
    });
    expect(check.status).toBe(200);
    expect(check.json.ok).toBe(true);

    const changed = await httpJson(`${base}/v1/host/lsp/check-changed`, { method: "POST" });
    expect(changed.status).toBe(200);

    const run = await httpJson(`${base}/v1/host/lsp/doctor`, { method: "POST" });
    expect(run.status).toBe(202);
    const doctor = await httpJson(`${base}/v1/host/lsp/doctor`);
    expect(doctor.status).toBe(200);
    expect(doctor.json).toHaveProperty("diagnosis");
    expect(doctor.json).toHaveProperty("probing");
  });
});

describe("setup over host wire (W11)", () => {
  it("rejects invalid answers and applies a valid setup", async () => {
    const invalid = await httpJson(`${base}/v1/host/setup`, { method: "POST", json: {} });
    expect(invalid.status).toBe(400);

    let persisted = false;
    let reconfigured = false;
    state.deps.saveConfig = () => {
      persisted = true;
    };
    state.deps.reconfigure = () => {
      reconfigured = true;
    };
    const answers = {
      provider: "openai",
      apiBase: "http://localhost:1234/v1",
      apiKey: "k",
      model: "m",
      contextWindow: 8192,
      maxToolIterations: 10,
      locale: "en",
      securityBashBlock: true,
      securityFlagsBlock: true,
      securityPathsRestrict: true,
    };
    const ok = await httpJson(`${base}/v1/host/setup`, { method: "POST", json: answers });
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
    expect(persisted).toBe(true);
    expect(reconfigured).toBe(true);
    expect(state.config.model).toBe("m");
  });

  it("switches the wizard locale", async () => {
    const res = await httpJson(`${base}/v1/host/setup/locale`, {
      method: "POST",
      json: { locale: "ru" },
    });
    expect(res.status).toBe(200);
    expect(res.json.locale).toBe("ru");
  });
});
