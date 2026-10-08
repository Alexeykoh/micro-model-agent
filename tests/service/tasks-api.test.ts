import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, ToolEvent } from "../../src/core/types";
import type { AppConfig } from "../../src/config/types";
import { startAgentService } from "../../src/modules/service/module";
import type { ServiceDeps } from "../../src/modules/service/state";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;
const gates: Array<() => void> = [];

/** Быстрый агент: стримит текст и один tool start/end. */
function fastAgent(text: string) {
  return {
    async run(
      _input: string,
      onChunk?: (c: string) => void,
      _onMeta?: unknown,
      onTool?: (ev: ToolEvent) => void,
    ): Promise<AgentResult> {
      onChunk?.(text);
      onTool?.({ type: "start", tool: "read_file", args: { path: "a" } });
      onTool?.({ type: "end", tool: "read_file", args: { path: "a" }, output: "ok", duration: 1 });
      return { success: true, text, iterationCount: 1, promptTokens: 10, completionTokens: 5, totalCost: 0 };
    },
    setPromptIO() {},
    shutdown() {},
  };
}

/** Агент со структурированным ответом: первый вызов невалиден (если retry нужен). */
function schemaAgent(alwaysInvalid: boolean) {
  let calls = 0;
  return {
    calls: () => calls,
    agent: {
      async run(): Promise<AgentResult> {
        calls++;
        const text = alwaysInvalid || calls === 1 ? '{"wrong":true}' : '{"title":"ok","score":3}';
        return { success: true, text, iterationCount: 1 };
      },
      setPromptIO() {},
      shutdown() {},
    },
  };
}

/** Медленный агент: держит ход до resolve гейта. */
function slowAgent() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  gates.push(release);
  return {
    agent: {
      async run(): Promise<AgentResult> {
        await gate;
        return { success: true, text: "slow-done", iterationCount: 1 };
      },
      setPromptIO() {},
      shutdown() {},
    },
    release,
  };
}

function makeDeps(agent: unknown, patch: (c: AppConfig) => void = () => {}): ServiceDeps {
  return makeServiceDeps({ dir, agent, patch });
}

beforeEach(() => {
  dir = tempServiceDir();
});
afterEach(() => {
  for (const release of gates.splice(0)) release();
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

async function boot(deps: ServiceDeps): Promise<string> {
  const svc = startAgentService(deps);
  stop = svc.stop;
  return await svc.url;
}

function submit(
  url: string,
  sessionId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return httpJson(`${url}/v1/sessions/${sessionId}/tasks`, { method: "POST", json: body, headers });
}

async function waitStatus(url: string, jobId: string, status: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const res = await httpJson(`${url}/v1/tasks/${jobId}`);
    if (res.json.status === status) return res.json;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`task ${jobId} did not reach ${status}`);
}

describe("tasks api", () => {
  it("submits a job, returns 202, and completes via pull", async () => {
    const url = await boot(makeDeps(fastAgent("hello")));
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, { input: "do it", mode: "job" });
    expect(res.status).toBe(202);
    expect(String(res.headers.location)).toMatch(/^\/v1\/tasks\/job_/);
    expect(["queued", "running"]).toContain(res.json.status);
    const jobId = res.json.jobId as string;

    const done = await waitStatus(url, jobId, "succeeded");
    expect((done.result as { text: string }).text).toBe("hello");
    expect(done.usage).toMatchObject({ promptTokens: 10, completionTokens: 5 });
  });

  it("wait:true blocks until terminal", async () => {
    const url = await boot(makeDeps(fastAgent("done-now")));
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, { input: "x", mode: "job", wait: true });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("succeeded");
    expect((res.json.result as { text: string }).text).toBe("done-now");
  });

  it("404s an unknown session", async () => {
    const url = await boot(makeDeps(fastAgent("x")));
    const res = await submit(url, "ses_missing", { input: "x" });
    expect(res.status).toBe(404);
  });

  it("deduplicates with Idempotency-Key and rejects a different body", async () => {
    const url = await boot(makeDeps(fastAgent("idem")));
    const sid = await firstSessionId(url);
    const headers = { "Idempotency-Key": "k1" };
    const first = await submit(url, sid, { input: "same" }, headers);
    const second = await submit(url, sid, { input: "same" }, headers);
    expect(second.json.jobId).toBe(first.json.jobId);
    const conflict = await submit(url, sid, { input: "different" }, headers);
    expect(conflict.status).toBe(409);
  });

  it("queues on a busy session and cancels the queued task", async () => {
    const slow = slowAgent();
    const url = await boot(makeDeps(slow.agent));
    const sid = await firstSessionId(url);

    const a = await submit(url, sid, { input: "a", mode: "job" });
    const b = await submit(url, sid, { input: "b", mode: "job" });
    expect(a.json.jobId).not.toBe(b.json.jobId);

    const cancel = await httpJson(`${url}/v1/tasks/${b.json.jobId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(202);

    slow.release();
    await waitStatus(url, a.json.jobId as string, "succeeded");
    const cancelled = await waitStatus(url, b.json.jobId as string, "cancelled");
    expect(cancelled.jobId).toBe(b.json.jobId);
  });

  it("429s when the session queue is full", async () => {
    const slow = slowAgent();
    const url = await boot(
      makeDeps(slow.agent, (c) => {
        c.service.maxQueueLength = 1;
      }),
    );
    const sid = await firstSessionId(url);
    expect((await submit(url, sid, { input: "a" })).status).toBe(202);
    expect((await submit(url, sid, { input: "b" })).status).toBe(202);
    const third = await submit(url, sid, { input: "c" });
    expect(third.status).toBe(429);
    expect(String(third.json.type)).toContain("queue-full");
  });

  it("parses structured output with a single retry", async () => {
    const sa = schemaAgent(false);
    const url = await boot(makeDeps(sa.agent));
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, {
      input: "x",
      mode: "job",
      wait: true,
      output: {
        format: "json",
        schema: {
          type: "object",
          required: ["title", "score"],
          properties: { title: { type: "string" }, score: { type: "number" } },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("succeeded");
    expect((res.json.result as { data: unknown }).data).toEqual({ title: "ok", score: 3 });
    expect(sa.calls()).toBe(2);
  });

  it("fails with output-invalid when validation keeps failing", async () => {
    const sa = schemaAgent(true);
    const url = await boot(makeDeps(sa.agent));
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, {
      input: "x",
      mode: "job",
      wait: true,
      output: { format: "json", schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } },
    });
    expect(res.json.status).toBe("failed");
    expect(String((res.json.error as { type: string }).type)).toContain("output-invalid");
  });

  it("404s an unknown task", async () => {
    const url = await boot(makeDeps(fastAgent("x")));
    const res = await httpJson(`${url}/v1/tasks/job_nope`);
    expect(res.status).toBe(404);
    expect(String(res.json.type)).toContain("no-task");
  });
});
