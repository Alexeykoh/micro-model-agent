import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, ToolEvent } from "../../src/core/types";
import type { SessionRunner } from "../../src/core/bootstrap/session-runner";
import type { AppConfig } from "../../src/config/types";
import { startAgentService } from "../../src/modules/service/module";
import type { ServiceDeps } from "../../src/modules/service/state";
import { signature } from "../../src/modules/service/runtime/webhook";
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

/** Агент, чей `run` висит до `shutdown` (эмуляция кооперативного обрыва). */
function abortableAgent() {
  let rejectRun: ((err: unknown) => void) | undefined;
  return {
    agent: {
      run(): Promise<AgentResult> {
        return new Promise<AgentResult>((_resolve, reject) => {
          rejectRun = reject;
        });
      },
      setPromptIO() {},
      shutdown() {
        rejectRun?.(new Error("AbortError"));
      },
    },
  };
}

/** Агент, эмитящий один tool start/end указанного имени. */
function toolCallingAgent(tool: string) {
  return {
    async run(
      _input: string,
      _onChunk?: unknown,
      _onMeta?: unknown,
      onTool?: (ev: ToolEvent) => void,
    ): Promise<AgentResult> {
      onTool?.({ type: "start", tool, args: {} });
      onTool?.({ type: "end", tool, args: {}, output: "denied", error: true });
      return { success: true, text: "done", iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
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

/** Депы, где фабрика раннера отдаёт созданный раннер в колбэк (для инспекции ctx). */
function depsWithRunner(agent: unknown, onRunner: (r: SessionRunner) => void): ServiceDeps {
  const deps = makeServiceDeps({ dir, agent });
  const factory = deps.spawnRunner!;
  deps.spawnRunner = (id) => {
    const runner = factory(id);
    onRunner(runner);
    return runner;
  };
  return deps;
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

  it("validates the submit body", async () => {
    const url = await boot(makeDeps(fastAgent("x")));
    const sid = await firstSessionId(url);
    expect((await submit(url, sid, { input: "   " })).status).toBe(400);
    expect((await submit(url, sid, { input: "x", output: { format: "xml" } })).status).toBe(422);
    expect((await submit(url, sid, { input: "x", toolAllowlist: [1] })).status).toBe(400);
    expect((await submit(url, sid, { input: "x", timeoutMs: "soon" })).status).toBe(400);
  });

  it("supports output.format=text", async () => {
    const url = await boot(makeDeps(fastAgent("plain")));
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, { input: "x", wait: true, output: { format: "text" } });
    expect(res.json.status).toBe("succeeded");
    expect((res.json.result as { text: string }).text).toBe("plain");
  });

  it("times out a hanging task", async () => {
    const ab = abortableAgent();
    const url = await boot(makeDeps(ab.agent));
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, { input: "hang", mode: "job", wait: true, timeoutMs: 60 });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("timeout");
    expect(String((res.json.error as { type: string }).type)).toContain("timeout");
  });

  it("cancels a running task cooperatively", async () => {
    const ab = abortableAgent();
    const url = await boot(makeDeps(ab.agent));
    const sid = await firstSessionId(url);
    const submitted = await submit(url, sid, { input: "run", mode: "job" });
    const jobId = submitted.json.jobId as string;
    await waitStatus(url, jobId, "running");
    const cancel = await httpJson(`${url}/v1/tasks/${jobId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(202);
    await waitStatus(url, jobId, "cancelled");
  });

  it("404s cancel for an unknown task and 200s a terminal one", async () => {
    const url = await boot(makeDeps(fastAgent("ok")));
    expect((await httpJson(`${url}/v1/tasks/job_x/cancel`, { method: "POST" })).status).toBe(404);
    const sid = await firstSessionId(url);
    const done = await submit(url, sid, { input: "x", mode: "job", wait: true });
    const again = await httpJson(`${url}/v1/tasks/${done.json.jobId}/cancel`, { method: "POST" });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe("succeeded");
  });

  it("404s answer for an unknown task", async () => {
    const url = await boot(makeDeps(fastAgent("x")));
    const res = await httpJson(`${url}/v1/tasks/job_x/answer`, { method: "POST", json: { id: "q1" } });
    expect(res.status).toBe(404);
  });

  it("pushes a signed webhook on completion", async () => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    const webhookFetch = (async (_u: string | URL, init?: RequestInit) => {
      calls.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const url = await boot(
      makeServiceDeps({
        dir,
        agent: fastAgent("hook"),
        webhookFetch,
        patch: (c) => {
          c.service.webhookSecret = "s3";
        },
      }),
    );
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, {
      input: "x",
      mode: "job",
      wait: true,
      callbackUrl: "http://callback.test/hook",
    });
    expect(res.json.status).toBe("succeeded");
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].body) as { status: string; jobId: string };
    expect(body.status).toBe("succeeded");
    expect(calls[0].headers["X-Mma-Signature"]).toBe(
      signature("s3", calls[0].headers["X-Mma-Timestamp"], calls[0].body),
    );
  });

  it("rejects a loopback callbackUrl with 422 and never calls it (W13 SSRF)", async () => {
    let called = 0;
    const webhookFetch = (async () => {
      called++;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const url = await boot(makeServiceDeps({ dir, agent: fastAgent("x"), webhookFetch }));
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, {
      input: "x",
      mode: "job",
      wait: true,
      callbackUrl: "http://127.0.0.1:9200/_search",
    });
    expect(res.status).toBe(422);
    expect(res.json.title).toBe("callbackUrl not allowed");
    expect(called).toBe(0);
  });

  it("applies the job toolAllowlist to the runner and restores it", async () => {
    let applied: string[] | undefined;
    const deps = depsWithRunner(fastAgent("ok"), (runner) => {
      let value: string[] | undefined;
      Object.defineProperty(runner.toolCtx, "toolAllowlist", {
        configurable: true,
        get: () => value,
        set: (next: string[] | undefined) => {
          value = next;
          if (next) applied = next;
        },
      });
    });
    const url = await boot(deps);
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, {
      input: "x",
      mode: "job",
      wait: true,
      toolAllowlist: ["read_file"],
    });
    expect(res.json.status).toBe("succeeded");
    expect(applied).toEqual(["read_file"]);
  });

  it("does not restrict tools for interactive tasks", async () => {
    let applied: string[] | undefined;
    const deps = depsWithRunner(fastAgent("ok"), (runner) => {
      let value: string[] | undefined;
      Object.defineProperty(runner.toolCtx, "toolAllowlist", {
        configurable: true,
        get: () => value,
        set: (next: string[] | undefined) => {
          value = next;
          if (next) applied = next;
        },
      });
    });
    const url = await boot(deps);
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, {
      input: "x",
      mode: "interactive",
      wait: true,
      toolAllowlist: ["read_file"],
    });
    expect(res.json.status).toBe("succeeded");
    expect(applied).toBeUndefined();
  });

  it("fails a job that calls a tool outside the allowlist", async () => {
    const url = await boot(makeDeps(toolCallingAgent("bash")));
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, {
      input: "x",
      mode: "job",
      wait: true,
      toolAllowlist: ["read_file"],
    });
    expect(res.json.status).toBe("failed");
    expect(String((res.json.error as { type: string }).type)).toContain("tool-forbidden");
  });

  it("fails a job that calls an interactive tool", async () => {
    const url = await boot(makeDeps(toolCallingAgent("question")));
    const sid = await firstSessionId(url);
    const res = await submit(url, sid, { input: "x", mode: "job", wait: true });
    expect(res.json.status).toBe("failed");
    expect(String((res.json.error as { type: string }).type)).toContain("tool-forbidden");
  });

  it("logs the tenant/run context to the session log", async () => {
    const url = await boot(
      makeDeps(fastAgent("ok"), (c) => {
        c.service.tenant = "acme";
      }),
    );
    const sid = await firstSessionId(url);
    await submit(
      url,
      sid,
      { input: "x", mode: "job", wait: true },
      { "X-Mma-Tenant": "acme", "X-Mma-Principal": "u1", "X-Mma-Run": "run-7" },
    );
    const logPath = join(dir, sid, "session.jsonl");
    const entries = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const serviceTask = entries.find((e) => e.type === "service_task");
    expect(serviceTask).toBeTruthy();
    expect(serviceTask?.tenantId).toBe("acme");
    expect(serviceTask?.principalId).toBe("u1");
    expect(serviceTask?.runId).toBe("run-7");
    expect(typeof serviceTask?.jobId).toBe("string");
  });

  it("404s an unknown task", async () => {
    const url = await boot(makeDeps(fastAgent("x")));
    const res = await httpJson(`${url}/v1/tasks/job_nope`);
    expect(res.status).toBe(404);
    expect(String(res.json.type)).toContain("no-task");
  });
});
