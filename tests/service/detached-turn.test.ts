/**
 * W13: окно переподключения отвязанного interactive-хода.
 *
 * `service.detachedTurnGraceMs = 0` (дефолт) — прежнее поведение: закрытие
 * последнего SSE-клиента отменяет ход. >0 — ход ждёт reconnect, помечается
 * `detached`, по истечении окна отменяется с явным событием.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import type { AgentServiceState } from "../../src/modules/service/state";
import { RemoteHost } from "../../src/modules/daemon/remote-host";
import type { HostEvent } from "../../src/core/host";
import { DEFAULTS } from "../../src/config/defaults";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;
let base: string;
let sessionId: string;
let state: AgentServiceState;

function hangingAgent(gate: { release: () => void }) {
  let released = false;
  return {
    async run(): Promise<AgentResult> {
      if (!released) await new Promise<void>((resolve) => (gate.release = resolve));
      released = true;
      return { success: true, text: "done", iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {
      gate.release();
    },
    pause() {},
    resume() {},
  };
}

async function start(graceMs: number) {
  dir = tempServiceDir();
  const gate = { release: () => {} };
  const deps = makeServiceDeps({
    dir,
    agent: hangingAgent(gate),
    patch: (c) => {
      c.service.detachedTurnGraceMs = graceMs;
    },
  });
  const svc = startAgentService(deps);
  stop = svc.stop;
  state = svc.state;
  base = await svc.url;
  sessionId = await firstSessionId(base);
  return gate;
}

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitStatus(jobId: string, status: string, ms = 3000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if ((await jobStatus(jobId)) === status) return;
    if (Date.now() - started > ms) throw new Error(`job ${jobId} did not reach ${status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function jobStatus(jobId: string): Promise<string> {
  const res = await httpJson(`${base}/v1/tasks/${jobId}`);
  return String(res.json.status);
}

afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

describe("detached interactive turn (W13)", () => {
  it("defaults to immediate cancel when the last client leaves", async () => {
    expect(DEFAULTS.service.detachedTurnGraceMs).toBe(0);
    await start(0);
    const host = new RemoteHost({ baseUrl: base, sessionId });
    const events: HostEvent[] = [];
    host.subscribeEvents((ev) => events.push(ev));

    const submitted = (await host.submit("go")) as { jobId: string };
    await waitFor(() => events.some((e) => e.type === "task.started"));
    host.dispose();

    await waitStatus(submitted.jobId, "cancelled");
    expect(await jobStatus(submitted.jobId)).toBe("cancelled");
  });

  it("keeps the turn alive for a reconnect within the grace window", async () => {
    const gate = await start(500);
    const first = new RemoteHost({ baseUrl: base, sessionId });
    const firstEvents: HostEvent[] = [];
    first.subscribeEvents((ev) => firstEvents.push(ev));

    const submitted = (await first.submit("go")) as { jobId: string };
    await waitFor(() => firstEvents.some((e) => e.type === "task.started"));
    first.dispose();

    expect(await jobStatus(submitted.jobId)).toBe("running");

    const second = new RemoteHost({ baseUrl: base, sessionId });
    const secondEvents: HostEvent[] = [];
    second.subscribeEvents((ev) => secondEvents.push(ev));
    await waitFor(() => secondEvents.some((e) => e.type === "task.attached"));

    gate.release();
    await waitFor(() => secondEvents.some((e) => e.type === "task.finished"));
    expect(await jobStatus(submitted.jobId)).toBe("succeeded");
    second.dispose();
  });

  it("cancels the turn when the grace window expires", async () => {
    await start(40);
    const host = new RemoteHost({ baseUrl: base, sessionId });
    const events: HostEvent[] = [];
    host.subscribeEvents((ev) => events.push(ev));

    const submitted = (await host.submit("go")) as { jobId: string };
    await waitFor(() => events.some((e) => e.type === "task.started"));
    host.dispose();

    await new Promise((r) => setTimeout(r, 120));
    expect(await jobStatus(submitted.jobId)).toBe("cancelled");
    const types = state.envelopes.since(sessionId, 0).map((e) => e.type);
    expect(types).toContain("task.detached");
    expect(types).toContain("task.detached_timeout");
  });
});
