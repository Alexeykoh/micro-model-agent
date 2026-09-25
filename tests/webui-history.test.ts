import { describe, it, expect } from "vitest";
import { createWebUiState, type WebSessionManager } from "../src/modules/webui/state";
import type { SessionLogEntry } from "../src/modules/session/store";
import type { SessionMeta, SessionMessage } from "../src/modules/session/types";
import { doFetch, withServer } from "./helpers/webui-server";




function meta(id: string): SessionMeta {
  return {
    id,
    name: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    messageCount: 1,
    model: "m",
    contextWindow: 32768,
    projectDir: "/tmp",
  };
}

const TS = "2026-01-01T00:00:00.000Z";

/** Minimal stub with only the history readers implemented. */
function fakeSessions(opts: {
  metas: SessionMeta[];
  logs?: Record<string, SessionLogEntry[]>;
  history?: Record<string, SessionMessage[]>;
}): WebSessionManager {
  const store = new Map(opts.metas.map((m) => [m.id, m]));
  return {
    list: () => [...store.values()],
    get: (id) => store.get(id) ?? null,
    getActive: () => null,
    setActive: () => {},
    delete: (id) => {
      store.delete(id);
    },
    loadSessionLog: (id) => opts.logs?.[id] ?? [],
    getHistory: (id) => opts.history?.[id] ?? [],
  };
}

const SECRET = "sk-abcdefghijklmnop123456";

describe("webui session history REST", () => {
  it("GET /api/sessions/:id/history returns a normalized, scrubbed transcript", async () => {
    const log: SessionLogEntry[] = [
      { ts: TS, type: "user", content: `hello ${SECRET}` },
      { ts: TS, type: "reasoning", content: "thinking hard" },
      { ts: TS, type: "assistant", content: "the answer" },
      {
        ts: TS,
        type: "tool_call",
        tool: "read_file",
        tool_call_id: "c1",
        args: { path: "/x", apiKey: SECRET },
      },
      { ts: TS, type: "tool_result", tool: "read_file", tool_call_id: "c1", success: true, duration: 12 },
      { ts: TS, type: "plan", content: "do things" },
      { ts: TS, type: "llm_usage", promptTokens: 1 },
      { ts: TS, type: "tool_defs", toolCount: 2 },
    ];
    const s = createWebUiState();
    s.sessionManager = fakeSessions({ metas: [meta("s1")], logs: { s1: log } });

    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions/s1/history`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; history: Array<Record<string, unknown>> };
      expect(body.id).toBe("s1");
      expect(body.history.map((h) => h.kind)).toEqual([
        "user",
        "reasoning",
        "assistant",
        "tool_call",
        "tool_result",
        "plan",
      ]);

      const [user, reasoning, assistant, call, result] = body.history;
      expect(user.text).toContain("sk-[REDACTED]");
      expect(String(user.text)).not.toContain("abcdefghijklmnop");
      expect(reasoning.text).toBe("thinking hard");
      expect(assistant.text).toBe("the answer");
      expect(call.name).toBe("read_file");
      expect(call.toolCallId).toBe("c1");
      expect((call.args as Record<string, unknown>).apiKey).toBe("sk-[REDACTED]");
      expect(result).toMatchObject({ kind: "tool_result", tool: "read_file", success: true, duration: 12 });
    });
  });

  it("caps the transcript to the last historyTail entries", async () => {
    const log: SessionLogEntry[] = [];
    for (let i = 0; i < 10; i++) log.push({ ts: TS, type: "user", content: `m${i}` });
    const s = createWebUiState();
    s.historyTail = 3;
    s.sessionManager = fakeSessions({ metas: [meta("s1")], logs: { s1: log } });

    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions/s1/history`);
      const body = (await res.json()) as { history: Array<{ text?: string }> };
      expect(body.history.map((h) => h.text)).toEqual(["m7", "m8", "m9"]);
    });
  });

  it("falls back to message history when the log is empty", async () => {
    const history: SessionMessage[] = [
      { role: "user", content: "hi", timestamp: TS },
      { role: "assistant", content: "yo", timestamp: TS },
      { role: "tool", content: "out", name: "bash", tool_call_id: "t1", timestamp: TS },
    ];
    const s = createWebUiState();
    s.sessionManager = fakeSessions({ metas: [meta("s1")], history: { s1: history } });

    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions/s1/history`);
      const body = (await res.json()) as { history: Array<Record<string, unknown>> };
      expect(body.history.map((h) => h.kind)).toEqual(["user", "assistant", "tool_result"]);
      expect(body.history[0].text).toBe("hi");
      expect(body.history[2]).toMatchObject({ tool: "bash", toolCallId: "t1" });
    });
  });

  it("returns 404 for an unknown session", async () => {
    const s = createWebUiState();
    s.sessionManager = fakeSessions({ metas: [meta("s1")] });
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions/ghost/history`);
      expect(res.status).toBe(404);
    });
  });

  it("returns 503 when no session manager is wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions/s1/history`);
      expect(res.status).toBe(503);
    });
  });

  it("requires a token when one is configured", async () => {
    const s = createWebUiState();
    s.token = "s3cret";
    s.sessionManager = fakeSessions({ metas: [meta("s1")], logs: { s1: [] } });
    await withServer(s, async (base) => {
      const denied = await doFetch(`${base}/api/sessions/s1/history`);
      expect(denied.status).toBe(401);

      const allowed = await doFetch(`${base}/api/sessions/s1/history`, {
        headers: { "x-mma-token": "s3cret" },
      });
      expect(allowed.status).toBe(200);
    });
  });
});
