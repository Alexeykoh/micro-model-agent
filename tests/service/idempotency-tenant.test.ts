/**
 * W10.2: идемпотентность и вопросы привязаны к тенанту/задаче, а не к
 * подконтрольным клиенту заголовкам.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../../src/core/types";
import type { PromptIO } from "../../src/tools/prompt-io";
import type { AppConfig } from "../../src/config/types";
import { startAgentService } from "../../src/modules/service/module";
import { createServiceState } from "../../src/modules/service/state";
import {
  MAX_PENDING_QUESTIONS,
  QUESTION_TTL_MS,
  servicePromptIO,
} from "../../src/modules/service/runtime/prompt-io";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;

function fastAgent(text: string) {
  return {
    async run(_input: string, onChunk?: (c: string) => void): Promise<AgentResult> {
      onChunk?.(text);
      return { success: true, text, iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
  };
}

/** Агент, который спрашивает через PromptIO и возвращает ответ модели. */
function askingAgent(): { agent: unknown; ios: PromptIO[] } {
  const ios: PromptIO[] = [];
  const agent = {
    setPromptIO(io: PromptIO) {
      ios.push(io);
    },
    async run(): Promise<AgentResult> {
      const io = ios[ios.length - 1];
      const answer = io ? await io.askText("continue?") : "";
      return { success: true, text: `answer=${answer}`, iterationCount: 1 };
    },
    shutdown() {},
  };
  return { agent, ios };
}

beforeEach(() => {
  dir = tempServiceDir();
});

afterEach(() => {
  vi.useRealTimers();
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

async function boot(
  agent: unknown,
  patch?: (c: AppConfig) => void,
): Promise<{ url: string; state: ReturnType<typeof createServiceState> }> {
  const svc = startAgentService(makeServiceDeps({ dir, agent, ...(patch ? { patch } : {}) }));
  stop = svc.stop;
  return { url: await svc.url, state: svc.state };
}

async function waitFor(pred: () => boolean, label: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function submit(
  url: string,
  sid: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return httpJson(`${url}/v1/sessions/${sid}/tasks`, { method: "POST", json: body, headers });
}

const acme = (c: AppConfig) => {
  c.service.tenant = "acme";
};

describe("idempotency ownership", () => {
  it("refuses to serve a cached job to a spoofed principal", async () => {
    const { url } = await boot(fastAgent("secret-result"), acme);
    const sid = await firstSessionId(url);
    const key = { "Idempotency-Key": "k1" };
    const alice = await submit(url, sid, { input: "same", mode: "job", wait: true }, { ...key, "X-Mma-Principal": "alice" });
    expect(alice.json.status).toBe("succeeded");

    const bob = await submit(url, sid, { input: "same", mode: "job", wait: true }, { ...key, "X-Mma-Principal": "bob" });
    expect(bob.status).toBe(409);
    expect(JSON.stringify(bob.json)).not.toContain("secret-result");
    expect(bob.json.jobId).toBeUndefined();
  });

  it("treats a reordered body as the same idempotent request", async () => {
    const { url } = await boot(fastAgent("ok"), acme);
    const sid = await firstSessionId(url);
    const headers = { "Idempotency-Key": "order" };
    const first = await submit(url, sid, { input: "x", mode: "job", timeoutMs: 1000 }, headers);
    const second = await submit(url, sid, { timeoutMs: 1000, input: "x", mode: "job" }, headers);
    expect([200, 202]).toContain(second.status);
    expect(second.json.jobId).toBe(first.json.jobId);
  });

  it("still conflicts on a different body for the same principal", async () => {
    const { url } = await boot(fastAgent("ok"), acme);
    const sid = await firstSessionId(url);
    const headers = { "Idempotency-Key": "body" };
    await submit(url, sid, { input: "a" }, headers);
    const conflict = await submit(url, sid, { input: "b" }, headers);
    expect(conflict.status).toBe(409);
  });
});

describe("question ownership", () => {
  it("does not let another task answer a foreign question", async () => {
    const { agent } = askingAgent();
    const { url, state } = await boot(agent);
    const sidA = await firstSessionId(url);
    const createdB = await httpJson(`${url}/v1/sessions`, { method: "POST", json: { name: "b" } });
    const sidB = createdB.json.id as string;

    const a = await submit(url, sidA, { input: "a", mode: "interactive" });
    await waitFor(() => state.pendingQuestions.size === 1, "question A");
    const b = await submit(url, sidB, { input: "b", mode: "interactive" });
    await waitFor(() => state.pendingQuestions.size === 2, "question B");

    const ids = [...state.pendingQuestions.keys()];
    const qB = ids[1];
    const hijack = await httpJson(`${url}/v1/tasks/${a.json.jobId}/answer`, {
      method: "POST",
      json: { id: qB, answer: "yes" },
    });
    expect(hijack.status).toBe(404);
    expect(state.pendingQuestions.has(qB)).toBe(true);

    const qA = ids[0];
    const own = await httpJson(`${url}/v1/tasks/${a.json.jobId}/answer`, {
      method: "POST",
      json: { id: qA, answer: "yes" },
    });
    expect(own.status).toBe(202);
    const done = await httpJson(`${url}/v1/tasks/${b.json.jobId}/answer`, {
      method: "POST",
      json: { id: qB, answer: "no" },
    });
    expect(done.status).toBe(202);
  });
});

describe("pending question bounds", () => {
  it("expires a question after the TTL and resumes the task", async () => {
    vi.useFakeTimers();
    const state = createServiceState(makeServiceDeps({ dir }));
    const task = state.tasks.create({ sessionId: "s", mode: "interactive", input: "x" });
    const answer = servicePromptIO(state, task).askText("still there?");
    expect(state.pendingQuestions.size).toBe(1);
    expect(state.tasks.get(task.jobId)?.status).toBe("waiting_input");

    vi.advanceTimersByTime(QUESTION_TTL_MS);
    await expect(answer).resolves.toBe("");
    expect(state.pendingQuestions.size).toBe(0);
    expect(state.tasks.get(task.jobId)?.status).toBe("running");
  });

  it("caps pending questions per process, evicting the oldest", async () => {
    vi.useFakeTimers();
    const state = createServiceState(makeServiceDeps({ dir }));
    const task = state.tasks.create({ sessionId: "s", mode: "interactive", input: "x" });
    const io = servicePromptIO(state, task);
    const answers: Array<Promise<string>> = [];
    for (let i = 0; i < MAX_PENDING_QUESTIONS + 1; i++) answers.push(io.askText(`q${i}`));
    expect(state.pendingQuestions.size).toBe(MAX_PENDING_QUESTIONS);
    await expect(answers[0]).resolves.toBe("");
  });
});
