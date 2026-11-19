// Web: смена/создание/удаление сессии двигает план (switchSession/forgetSession).
import { describe, it, expect } from "vitest";
import { createWebUiState, type WebSessionManager } from "../src/modules/webui/state";
import type { SessionMeta } from "../src/modules/session/types";
import { withServer, postJson, doFetch } from "./helpers/webui-server";

function meta(id: string, name: string): SessionMeta {
  return {
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    messageCount: 1,
    model: "m",
    contextWindow: 32768,
    projectDir: "/tmp",
  };
}

function fakeSessions(initial: SessionMeta[], activeId: string | null): WebSessionManager {
  const store = new Map(initial.map((m) => [m.id, m]));
  let active = activeId;
  let seq = initial.length;
  return {
    list: () => [...store.values()],
    get: (id) => store.get(id) ?? null,
    getActive: () => active,
    setActive: (id) => {
      if (!store.has(id)) throw new Error("not found");
      active = id;
    },
    create: (name) => {
      seq++;
      const m = meta(`s${seq}`, name || "new");
      store.set(m.id, m);
      active = m.id;
      return m;
    },
    delete: (id) => {
      if (!store.has(id)) throw new Error("not found");
      store.delete(id);
      if (active === id) active = null;
    },
  };
}

function fakeExec() {
  const calls: Array<{ op: string; id: string | null }> = [];
  return {
    calls,
    execModule: {
      switchSession: (id: string | null) => {
        calls.push({ op: "switch", id });
      },
      forgetSession: (id: string) => {
        calls.push({ op: "forget", id });
      },
    },
  };
}

describe("webui session ↔ plan binding", () => {
  it("activate переключает трекер плана", async () => {
    const s = createWebUiState();
    s.sessionManager = fakeSessions([meta("s1", "one"), meta("s2", "two")], "s1");
    const { calls, execModule } = fakeExec();
    s.execModule = execModule;

    await withServer(s, async (base) => {
      const ok = await postJson(base, "/api/sessions/activate", { id: "s2" });
      expect(ok.status).toBe(200);
      expect(calls).toEqual([{ op: "switch", id: "s2" }]);
    });
  });

  it("create переключает трекер на новую сессию", async () => {
    const s = createWebUiState();
    s.sessionManager = fakeSessions([meta("s1", "one")], "s1");
    const { calls, execModule } = fakeExec();
    s.execModule = execModule;

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/sessions", {});
      expect(res.status).toBe(201);
      const newId = (res.json as { session: { id: string } }).session.id;
      expect(calls).toEqual([{ op: "switch", id: newId }]);
    });
  });

  it("delete чистит слот плана удалённой сессии", async () => {
    const s = createWebUiState();
    s.sessionManager = fakeSessions([meta("s1", "one"), meta("s2", "two")], "s2");
    const { calls, execModule } = fakeExec();
    s.execModule = execModule;

    await withServer(s, async (base) => {
      const del = await doFetch(`${base}/api/sessions/s1`, { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(calls).toEqual([{ op: "forget", id: "s1" }]);
    });
  });

  it("работает и без execModule (fail-open, как без менеджера)", async () => {
    const s = createWebUiState();
    s.sessionManager = fakeSessions([meta("s1", "one"), meta("s2", "two")], "s1");

    await withServer(s, async (base) => {
      const ok = await postJson(base, "/api/sessions/activate", { id: "s2" });
      expect(ok.status).toBe(200);
      expect(s.sessionManager?.getActive()).toBe("s2");
    });
  });
});
