import { describe, expect, it } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import type { WebDaemonHost } from "../src/modules/webui/daemon-contracts";
import type { HostStateSnapshot } from "../src/core/host";
import { doFetch, withServer } from "./helpers/webui-server";

/** Минимальный демон: запоминает вызовы, отвечает предсказуемыми данными. */
function fakeDaemon() {
  const calls = { submitted: [] as string[], commands: [] as string[], deleted: [] as string[] };
  let sessionId = "S1";
  const host: WebDaemonHost = {
    isBusy: () => false,
    submit: async (text) => {
      calls.submitted.push(text);
      return { jobId: "job_1" };
    },
    interrupt: () => {},
    pause: async () => {},
    resume: async () => {},
    answer: async () => {},
    setSessionId: (id) => {
      sessionId = id;
    },
    dispose: () => {},
    getState: async (): Promise<HostStateSnapshot> => ({ busy: false, sessionId, model: "m" }),
    subscribeEvents: () => () => {},
    listSessions: async () => [{ id: sessionId, name: "s" } as never],
    createSession: async (name?: string) => ({ id: "S2", name: name ?? "" }) as never,
    deleteSession: async (id) => {
      calls.deleted.push(id);
    },
    getHistory: async () => [{ role: "user", content: "hi" }] as never,
    getLog: async () => [{ type: "usage" }] as never,
    getConfig: async () => ({ config: { model: "m" }, version: 2, registry: [] }),
    setConfig: async () => ({ ok: true, persisted: true }),
    listModels: async () => ({ models: ["m"] }),
    listFiles: async (path: string) => ({ path, entries: [{ name: "a.ts", type: "file" }], truncated: false }),
    executeCommand: async (line) => {
      calls.commands.push(line);
      return { ok: true, output: ["status: ok"] };
    },
  };
  return { host, calls };
}

describe("web daemon adapter (W4)", () => {
  it("proxies host-covered /api routes", async () => {
    const { host, calls } = fakeDaemon();
    const s = createWebUiState();
    s.daemon = host;
    s.bridge = host;

    await withServer(s, async (base) => {
      const state = await doFetch(`${base}/api/state`);
      expect(state.status).toBe(200);
      const stateBody = (await state.json()) as { state: HostStateSnapshot };
      expect(stateBody.state.sessionId).toBe("S1");

      const sessions = await doFetch(`${base}/api/sessions`);
      expect(sessions.status).toBe(200);
      expect((await sessions.json()) as { sessions: unknown[] }).toMatchObject({ sessions: [{}] });

      const message = await doFetch(`${base}/api/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(message.status).toBe(202);
      expect(calls.submitted).toEqual(["hello"]);

      const config = await doFetch(`${base}/api/config`);
      expect(config.status).toBe(200);
      expect(((await config.json()) as { version: number }).version).toBe(2);

      const models = await doFetch(`${base}/api/models`);
      expect(((await models.json()) as { models: string[] }).models).toEqual(["m"]);

      const command = await doFetch(`${base}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: "/status" }),
      });
      expect(command.status).toBe(200);
      expect(calls.commands).toEqual(["/status"]);

      const files = await doFetch(`${base}/api/files?path=`);
      expect(files.status).toBe(200);
      expect(((await files.json()) as { entries: unknown[] }).entries).toHaveLength(1);

      const history = await doFetch(`${base}/api/sessions/S1/history`);
      expect(history.status).toBe(200);
      expect(((await history.json()) as { messages: unknown[] }).messages).toHaveLength(1);

      const removed = await doFetch(`${base}/api/sessions/S1`, { method: "DELETE" });
      expect(removed.status).toBe(204);
      expect(calls.deleted).toEqual(["S1"]);
    });
  });

  it("answers 501 for panels the daemon does not expose yet", async () => {
    const { host } = fakeDaemon();
    const s = createWebUiState();
    s.daemon = host;
    s.bridge = host;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/file?path=x`);
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("daemon");
    });
  });
});
