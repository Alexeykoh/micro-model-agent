/**
 * W10.3: реестр задач ограничен и чистится (retention, кап событий, waiter'ы).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import type { AppConfig } from "../../src/config/types";
import { startAgentService } from "../../src/modules/service/module";
import { createServiceState } from "../../src/modules/service/state";
import { TaskRegistry } from "../../src/modules/service/runtime/task-registry";
import { TASK_EVENTS_MAX, emitEvent } from "../../src/modules/service/runtime/emit";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  dir = tempServiceDir();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

describe("task retention", () => {
  it("prunes an expired terminal task on the next create", () => {
    let now = 1_000;
    const reg = new TaskRegistry({
      retentionDays: 0.001, // 86.4 s
      idempotencyTtlHours: 1,
      now: () => now,
    });
    const old = reg.create({ sessionId: "s", mode: "job", input: "x" });
    reg.finish(old.jobId, { status: "succeeded" });
    expect(reg.size()).toBe(1);

    now += 2 * 60_000;
    const fresh = reg.create({ sessionId: "s", mode: "job", input: "y" });
    expect(reg.get(old.jobId)).toBeUndefined();
    expect(reg.get(fresh.jobId)).toBeDefined();
    expect(reg.size()).toBe(1);
  });

  it("prunes from the background timer", async () => {
    const state = createServiceState(
      makeServiceDeps({
        dir,
        pruneIntervalMs: 5,
        patch: (c: AppConfig) => {
          // 0.0000001 дня ≈ 8.6 мс — retention истекает между тиками таймера.
          c.service.resultRetentionDays = 0.0000001;
        },
      }),
    );
    const task = state.tasks.create({ sessionId: "s", mode: "job", input: "x" });
    state.tasks.finish(task.jobId, { status: "succeeded" });
    expect(state.tasks.size()).toBe(1);

    const start = Date.now();
    while (state.tasks.size() !== 0 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state.tasks.size()).toBe(0);
    if (state.pruneTimer) clearInterval(state.pruneTimer);
  });

  it("caps task.events with FIFO eviction", () => {
    const state = createServiceState(makeServiceDeps({ dir }));
    const task = state.tasks.create({ sessionId: "s", mode: "job", input: "x" });
    for (let i = 0; i < TASK_EVENTS_MAX + 5; i++) emitEvent(state, task, "phase", { i });
    expect(task.events).toHaveLength(TASK_EVENTS_MAX);
    expect(task.events[0].seq).toBe(6);
    expect(task.events.at(-1)?.seq).toBe(TASK_EVENTS_MAX + 5);
    if (state.pruneTimer) clearInterval(state.pruneTimer);
  });

  it("removes a waiter when the wait is aborted", async () => {
    const reg = new TaskRegistry({ retentionDays: 1, idempotencyTtlHours: 1 });
    const task = reg.create({ sessionId: "s", mode: "job", input: "x" });
    const controller = new AbortController();
    const pending = reg.whenFinished(task.jobId, controller.signal);
    expect(task.waiters).toHaveLength(1);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(task.waiters).toHaveLength(0);
  });
});

describe("synchronous wait", () => {
  it("returns 202 and drops the waiter when syncWaitMs elapses", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = {
      async run(): Promise<AgentResult> {
        await gate;
        return { success: true, text: "late", iterationCount: 1 };
      },
      setPromptIO() {},
      shutdown() {},
    };
    const svc = startAgentService(
      makeServiceDeps({
        dir,
        agent,
        patch: (c: AppConfig) => {
          c.service.syncWaitMs = 30;
        },
      }),
    );
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);
    const res = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "x", mode: "job", wait: true },
    });
    expect(res.status).toBe(202);
    const jobId = res.json.jobId as string;
    expect(svc.state.tasks.get(jobId)?.waiters).toHaveLength(0);
    release();
  });
});
