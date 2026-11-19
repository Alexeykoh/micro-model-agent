/**
 * W10d: вьюер файла и очередь сообщений по host wire.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import type { AgentServiceState } from "../../src/modules/service/state";
import { httpJson, httpRequest } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;
let base: string;
let sessionId: string;
let state: AgentServiceState;

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
  writeFileSync(join(dir, "readme.md"), "# hello", "utf8");
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

describe("host file viewer (W10d)", () => {
  it("serves a workspace file and rejects traversal", async () => {
    const ok = await httpRequest(`${base}/v1/host/file?path=readme.md`);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("hello");

    const traversal = await httpRequest(`${base}/v1/host/file?path=..%2Fsecrets.txt`);
    expect(traversal.status).toBe(403);
  });
});

describe("host queue (W10d)", () => {
  it("lists ids and reports queue actions honestly", async () => {
    const list = await httpJson(`${base}/v1/host/sessions/${sessionId}/queue`);
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ queued: 0, ids: [] });

    state.pool.enqueue(sessionId, "queued text", [], sessionId);
    const withItem = await httpJson(`${base}/v1/host/sessions/${sessionId}/queue`);
    expect(withItem.json.queued).toBe(1);
    const ids = withItem.json.ids as string[];
    expect(ids).toHaveLength(1);

    const cancel = await httpJson(`${base}/v1/host/sessions/${sessionId}/queue/cancel`, {
      method: "POST",
      json: { id: ids[0] },
    });
    expect(cancel.status).toBe(200);
    expect(cancel.json).toEqual({ ok: true });

    const again = await httpJson(`${base}/v1/host/sessions/${sessionId}/queue/cancel`, {
      method: "POST",
      json: { id: ids[0] },
    });
    expect(again.status).toBe(404);
  });

  it("exposes queued ids in the state snapshot", async () => {
    state.pool.enqueue(sessionId, "queued text", [], sessionId);
    const snap = await httpJson(`${base}/v1/host/state?session=${sessionId}`);
    expect((snap.json.state as { queuedIds: string[] }).queuedIds).toHaveLength(1);
  });
});
