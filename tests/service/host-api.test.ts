import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import type { AgentServiceState } from "../../src/modules/service/state";
import { startAgentService } from "../../src/modules/service/module";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

/**
 * Host wire W2: те же прогон и поток, что job API, но через `/v1/host/*`.
 */

let dir: string;
let stop: (() => void) | undefined;
let base: string;
let sessionId: string;
let state: AgentServiceState;

function fastAgent() {
  return {
    async run(): Promise<AgentResult> {
      return { success: true, text: "host-ok", iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
    pause() {},
    resume() {},
  };
}

beforeEach(async () => {
  dir = tempServiceDir();
  const svc = startAgentService(makeServiceDeps({ dir, agent: fastAgent() }));
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

describe("GET /v1/host/state", () => {
  it("returns a HostStateSnapshot plus workspace/version/protocol", async () => {
    const res = await httpJson(`${base}/v1/host/state`);
    expect(res.status).toBe(200);
    expect(res.json.protocol).toBe("1");
    expect(typeof res.json.workspace).toBe("string");
    const state = res.json.state as Record<string, unknown>;
    expect(state.busy).toBe(false);
    expect(state.sessionId).toBe(sessionId);
  });

  it("scopes the snapshot to ?session=", async () => {
    const res = await httpJson(`${base}/v1/host/state?session=${sessionId}`);
    expect(res.status).toBe(200);
    expect((res.json.state as Record<string, unknown>).sessionId).toBe(sessionId);
  });
});

describe("POST /v1/host/sessions/:id/submit", () => {
  it("starts an interactive turn and streams it to completion", async () => {
    const res = await httpJson(`${base}/v1/host/sessions/${sessionId}/submit`, {
      method: "POST",
      json: { text: "hello" },
    });
    expect(res.status).toBe(202);
    const turnId = res.json.turnId as string;
    expect(turnId).toBeTruthy();
    expect(res.json.sessionId).toBe(sessionId);

    const status = await waitTask(base, turnId, "succeeded");
    expect(status).toBe("succeeded");
  });

  it("rejects an empty text and malformed images, accepts data URLs", async () => {
    const empty = await httpJson(`${base}/v1/host/sessions/${sessionId}/submit`, {
      method: "POST",
      json: { text: "  " },
    });
    expect(empty.status).toBe(400);

    const bad = await httpJson(`${base}/v1/host/sessions/${sessionId}/submit`, {
      method: "POST",
      json: { text: "hi", images: ["https://example.com/a.png"] },
    });
    expect(bad.status).toBe(422);

    const ok = await httpJson(`${base}/v1/host/sessions/${sessionId}/submit`, {
      method: "POST",
      json: { text: "hi", images: ["data:image/png;base64,AA=="] },
    });
    expect(ok.status).toBe(202);
  });

  it("404s for an unknown session", async () => {
    const res = await httpJson(`${base}/v1/host/sessions/ses_missing/submit`, {
      method: "POST",
      json: { text: "hello" },
    });
    expect(res.status).toBe(404);
  });
});

describe("host control routes", () => {
  it("interrupt is idempotent when idle", async () => {
    const res = await httpJson(`${base}/v1/host/sessions/${sessionId}/interrupt`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    expect(res.json.interrupted).toBe(false);
  });

  it("pause/resume need a live runner", async () => {
    const res = await httpJson(`${base}/v1/host/sessions/${sessionId}/pause`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("answer rejects an unknown question id", async () => {
    const res = await httpJson(`${base}/v1/host/sessions/${sessionId}/answer`, {
      method: "POST",
      json: { id: "q_nope", answer: 0 },
    });
    expect(res.status).toBe(404);
  });
});

describe("host sessions surface", () => {
  it("lists, creates, reads history/log and deletes sessions", async () => {
    const list = await httpJson(`${base}/v1/host/sessions`);
    expect(list.status).toBe(200);
    expect((list.json.sessions as unknown[]).length).toBeGreaterThan(0);

    const created = await httpJson(`${base}/v1/host/sessions`, {
      method: "POST",
      json: { name: "wire" },
    });
    expect(created.status).toBe(201);
    expect(created.json.name).toBe("wire");
    const id = created.json.id as string;

    const hist = await httpJson(`${base}/v1/host/sessions/${id}/history`);
    expect(hist.status).toBe(200);
    expect(Array.isArray(hist.json.messages)).toBe(true);

    const log = await httpJson(`${base}/v1/host/sessions/${id}/log?limit=5`);
    expect(log.status).toBe(200);
    expect(Array.isArray(log.json.entries)).toBe(true);

    const del = await httpJson(`${base}/v1/host/sessions/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const after = await httpJson(`${base}/v1/host/sessions`);
    expect((after.json.sessions as Array<{ id: string }>).some((x) => x.id === id)).toBe(false);
  });

  it("404s for history/log of an unknown session", async () => {
    expect((await httpJson(`${base}/v1/host/sessions/ses_missing/history`)).status).toBe(404);
    expect((await httpJson(`${base}/v1/host/sessions/ses_missing/log`)).status).toBe(404);
  });
});

describe("host files wire", () => {
  it("lists a workspace directory and rejects escapes", async () => {
    const ok = await httpJson(`${base}/v1/host/files`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.json.entries)).toBe(true);

    const traversal = await httpJson(`${base}/v1/host/files?path=${encodeURIComponent("..")}`);
    expect(traversal.status).toBe(403);
  });
});

describe("host memory/skills wire", () => {
  it("serves memory and skills when modules are wired", async () => {
    state.deps.memory = {
      getPreferences: () => ({ tone: "brief" }),
      read: () => "- fact one",
    } as never;
    state.deps.skills = {
      getLoaded: () => [{ name: "alpha" }],
      getAvailable: () => [{ name: "alpha" }, { name: "beta" }],
    } as never;

    const memory = await httpJson(`${base}/v1/host/memory`);
    expect(memory.status).toBe(200);
    expect((memory.json.categories as Array<{ name: string }>).length).toBeGreaterThan(0);
    expect((memory.json.preferences as Record<string, string>).tone).toBe("brief");

    const skills = await httpJson(`${base}/v1/host/skills`);
    expect(skills.status).toBe(200);
    expect(skills.json.skills).toEqual([
      { name: "alpha", enabled: true },
      { name: "beta", enabled: false },
    ]);
  });

  it("answers 503 when a module is not wired", async () => {
    state.deps.memory = undefined;
    state.deps.skills = undefined;
    expect((await httpJson(`${base}/v1/host/memory`)).status).toBe(503);
    expect((await httpJson(`${base}/v1/host/skills`)).status).toBe(503);
  });
});

describe("host git wire", () => {
  it("reports a non-repo workspace honestly", async () => {
    const res = await httpJson(`${base}/v1/host/git`);
    expect(res.status).toBe(200);
    expect(res.json.repo).toBe(false);

    const changes = await httpJson(`${base}/v1/host/git/changes`);
    expect(changes.status).toBe(200);
    expect(changes.json.files).toEqual([]);
  });
});

describe("host command wire", () => {
  it("runs supported commands and reports unsupported ones honestly", async () => {
    const status = await httpJson(`${base}/v1/host/sessions/${sessionId}/command`, {
      method: "POST",
      json: { line: "/status" },
    });
    expect(status.status).toBe(200);
    expect(status.json.ok).toBe(true);
    expect((status.json.output as string[]).some((l) => l.startsWith("model:"))).toBe(true);

    const help = await httpJson(`${base}/v1/host/sessions/${sessionId}/command`, {
      method: "POST",
      json: { line: "/help" },
    });
    expect(help.json.ok).toBe(true);

    const unknown = await httpJson(`${base}/v1/host/sessions/${sessionId}/command`, {
      method: "POST",
      json: { line: "/provider add" },
    });
    expect(unknown.json.ok).toBe(false);
    expect(String(unknown.json.error)).toContain("not supported");
  });
});

describe("host config and models", () => {
  it("writes a config key and reports persistence", async () => {
    const res = await httpJson(`${base}/v1/host/config`, {
      method: "POST",
      json: { key: "ui.themeMode", value: "dark" },
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(typeof res.json.persisted).toBe("boolean");
  });

  it("rejects an unknown config key", async () => {
    const res = await httpJson(`${base}/v1/host/config`, {
      method: "POST",
      json: { key: "nope.nope", value: 1 },
    });
    expect(res.status).toBe(400);
  });

  it("returns the redacted config and the key registry", async () => {
    const res = await httpJson(`${base}/v1/host/config`);
    expect(res.status).toBe(200);
    expect(typeof res.json.version).toBe("number");
    const registry = res.json.registry as Array<{ key: string }>;
    expect(Array.isArray(registry)).toBe(true);
    expect(registry.some((e) => e.key === "model")).toBe(true);
  });

  it("returns a models list", async () => {
    const res = await httpJson(`${base}/v1/host/models`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.models)).toBe(true);
  });
});

async function waitTask(url: string, jobId: string, status: string, ms = 3000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const res = await httpJson(`${url}/v1/tasks/${jobId}`);
    if (res.json.status === status) return status;
    if (Date.now() - start > ms) throw new Error(`task did not reach ${status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
