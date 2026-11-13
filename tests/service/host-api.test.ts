import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
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

  it("rejects an empty text and unsupported images", async () => {
    const empty = await httpJson(`${base}/v1/host/sessions/${sessionId}/submit`, {
      method: "POST",
      json: { text: "  " },
    });
    expect(empty.status).toBe(400);

    const images = await httpJson(`${base}/v1/host/sessions/${sessionId}/submit`, {
      method: "POST",
      json: { text: "hi", images: ["data:image/png;base64,AA=="] },
    });
    expect(images.status).toBe(422);
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

async function waitTask(url: string, jobId: string, status: string, ms = 3000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const res = await httpJson(`${url}/v1/tasks/${jobId}`);
    if (res.json.status === status) return status;
    if (Date.now() - start > ms) throw new Error(`task did not reach ${status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
