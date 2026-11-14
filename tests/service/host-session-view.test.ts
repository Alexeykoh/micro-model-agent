/**
 * W10c: read-поверхность сессии и поиск в демоне.
 *
 * Панели локального веба (system prompt, security, subagents, files search,
 * tool images) должны работать и в daemon-режиме — через `/v1/host/*`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import type { AgentServiceState } from "../../src/modules/service/state";
import { attachSubagentSink } from "../../src/modules/service/runtime/subagent-events";
import { RemoteHost } from "../../src/modules/daemon/remote-host";
import type { HostEvent } from "../../src/core/host";
import { httpJson } from "./http-client";
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

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Ставит приёмник субагентов и отдаёт emit для сценариев. */
function subagentEmitter(): (ev: unknown) => void {
  const runner = { toolCtx: {} as { subagentRuns?: unknown } };
  attachSubagentSink(state, sessionId, runner);
  return (ev) => (runner.toolCtx.subagentRuns as { emit: (e: unknown) => void }).emit(ev);
}

const startEvent = (runId: string, toolCallId: string) => ({
  kind: "start",
  runId,
  parentSessionId: sessionId,
  parentToolCallId: toolCallId,
  task: "check docs",
  at: Date.now(),
});

describe("host session view (W10c)", () => {
  it("serves system-prompt, security, subagents and search", async () => {
    const prompt = await httpJson(`${base}/v1/host/sessions/${sessionId}/system-prompt`);
    expect(prompt.status).toBe(200);
    expect(prompt.json.available).toBe(false);

    const security = await httpJson(`${base}/v1/host/sessions/${sessionId}/security?limit=5`);
    expect(security.status).toBe(200);
    expect(Array.isArray(security.json.events)).toBe(true);

    const subs = await httpJson(`${base}/v1/host/sessions/${sessionId}/subagents`);
    expect(subs.status).toBe(200);
    expect(subs.json.runs).toEqual([]);

    const search = await httpJson(`${base}/v1/host/search?q=package&names=1`);
    expect(search.status).toBe(200);
    expect(Array.isArray(search.json.results)).toBe(true);
  });

  it("404s for a missing tool image and a foreign session", async () => {
    const img = await httpJson(`${base}/v1/host/sessions/${sessionId}/images/nope.png`);
    expect(img.status).toBe(404);
    const missing = await httpJson(`${base}/v1/host/sessions/ses_missing/security`);
    expect(missing.status).toBe(404);
  });

  it("emits subagent events and exposes the run snapshot", async () => {
    const host = new RemoteHost({ baseUrl: base, sessionId });
    const events: HostEvent[] = [];
    host.subscribeEvents((ev) => events.push(ev));

    const emit = subagentEmitter();
    emit(startEvent("run-1", "t1"));

    expect(state.envelopes.since(sessionId, 0).some((e) => e.type === "subagent")).toBe(true);
    expect(state.subagentRuns.list(sessionId)).toHaveLength(1);

    await waitFor(() => events.some((e) => e.type === "subagent"));
    const wire = events.find((e) => e.type === "subagent");
    expect(wire?.data).toMatchObject({ runId: "run-1", kind: "start", parentToolCallId: "t1" });

    const subs = await httpJson(
      `${base}/v1/host/sessions/${sessionId}/subagents?toolCallId=t1`,
    );
    expect((subs.json.runs as unknown[]).length).toBe(1);

    const interrupted = await httpJson(
      `${base}/v1/host/sessions/${sessionId}/subagents/run-1/interrupt`,
      { method: "POST" },
    );
    expect(interrupted.status).toBe(409); // прогон уже не «running» без ручки остановки
    host.dispose();
  });
});
