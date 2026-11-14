/**
 * Один набор поведенческих тестов `Host` для обеих реализаций (спека §16):
 * `LocalHost` (in-process) и `RemoteHost` (HTTP+SSE). Разница только в
 * транспорте — ответы обязаны совпадать по форме и семантике.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../src/core/types";
import type { Host } from "../src/core/host";
import { LocalHost } from "../src/core/local-host";
import { RemoteHost } from "../src/modules/daemon/remote-host";
import { startAgentService } from "../src/modules/service/module";
import type { AgentServiceState } from "../src/modules/service/state";
import { runHostCommand } from "../src/modules/service/runtime/commands";
import { hostStateOf } from "../src/modules/service/runtime/host-state";
import { serializeConfigForWire } from "../src/config/redact";
import { configVersion } from "../src/config/persist";
import { buildConfigRegistry } from "../src/runtime/config-view";
import { applyConfigWrite, toConfigRaw } from "../src/runtime/config-write";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./service/harness";

let dir: string;
let stop: (() => void) | undefined;
let state: AgentServiceState;
let base: string;
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

/** `LocalHost` над тем же состоянием, что у сервиса: разница только в транспорте. */
function localHost(s: AgentServiceState): Host {
  return new LocalHost({
    isBusy: () => s.pool.anyBusy(),
    submit: async () => ({}),
    interrupt: () => {},
    subscribeOutput: () => () => {},
    executeCommand: (line) => runHostCommand(s, sessionId, line),
    getState: () => hostStateOf(s, sessionId),
    listSessions: () => s.deps.sessionManager?.list() ?? [],
    createSession: (name) => {
      if (!s.deps.sessionManager) throw new Error("sessions unavailable");
      return s.deps.sessionManager.create(name);
    },
    deleteSession: (id) => s.deps.sessionManager?.delete(id),
    getHistory: (id) => s.deps.sessionManager?.getHistory(id) ?? [],
    getLog: (id, opts) => s.deps.sessionManager?.loadSessionLog(id, opts ?? {}) ?? [],
    getConfig: () => ({
      config: serializeConfigForWire(s.config),
      registry: buildConfigRegistry(s.config),
      version: configVersion(s.config),
    }),
    setConfig: (key, value) =>
      applyConfigWrite(s.config, key, toConfigRaw(value), {
        saveConfig: s.deps.saveConfig,
        reconfigure: s.deps.reconfigure,
      }),
    listModels: () => ({ models: [] }),
  });
}

/** Поведенческий контракт, одинаковый для локального и удалённого хоста. */
function hostContract(name: string, make: () => Host): void {
  describe(name, () => {
    it("reports a state snapshot with a boolean busy flag", async () => {
      const host = make();
      const snap = await host.getState();
      expect(typeof snap.busy).toBe("boolean");
      expect(snap.sessionId).toBe(sessionId);
    });

    it("lists, creates and deletes sessions", async () => {
      const host = make();
      const before = await host.listSessions();
      expect(before.some((s) => s.id === sessionId)).toBe(true);

      const created = await host.createSession("parity");
      expect(created.name).toBe("parity");
      const after = await host.listSessions();
      expect(after.some((s) => s.id === created.id)).toBe(true);

      await host.deleteSession(created.id);
      const final = await host.listSessions();
      expect(final.some((s) => s.id === created.id)).toBe(false);
    });

    it("returns history and log arrays for a session", async () => {
      const host = make();
      expect(Array.isArray(await host.getHistory(sessionId))).toBe(true);
      expect(Array.isArray(await host.getLog(sessionId, { limit: 5 }))).toBe(true);
    });

    it("exposes the config registry and rejects an unknown key", async () => {
      const host = make();
      const cfg = await host.getConfig();
      expect(cfg.registry.some((e) => e.key === "model")).toBe(true);

      const bad = await host.setConfig("nope.nope", 1);
      expect(bad.ok).toBe(false);
    });

    it("reports an unsupported command honestly instead of a no-op", async () => {
      const host = make();
      const result = await host.executeCommand("/definitely-not-a-command");
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("not supported");
    });

    it("subscribes to events and unsubscribes safely", () => {
      const host = make();
      const off = host.subscribeEvents(() => {});
      expect(typeof off).toBe("function");
      off();
      off();
    });
  });
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

hostContract("Host contract: LocalHost", () => localHost(state));

hostContract("Host contract: RemoteHost", () => new RemoteHost({ baseUrl: base, sessionId }));
