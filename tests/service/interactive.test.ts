import { get } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import type { PromptIO } from "../../src/tools/prompt-io";
import { startAgentService } from "../../src/modules/service/module";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;

/** Агент, спрашивающий текст и отвечающий им. */
function interactiveAgent() {
  let io: PromptIO | undefined;
  return {
    async run(): Promise<AgentResult> {
      const answer = await io!.askText("What is your name?");
      return { success: true, text: `answer:${answer}`, iterationCount: 1 };
    },
    setPromptIO(value: PromptIO) {
      io = value;
    },
    shutdown() {},
  };
}

function fastAgent() {
  return {
    async run(): Promise<AgentResult> {
      return { success: true, text: "quick", iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
  };
}

beforeEach(() => {
  dir = tempServiceDir();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

function openSse(url: string): { text: () => string; close: () => void } {
  let buf = "";
  const request = get(url, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
    });
  });
  return { text: () => buf, close: () => request.destroy() };
}

function parseEvent(text: string, type: string): Record<string, unknown> | null {
  for (const block of text.split("\n\n")) {
    const header = /(^|\n)event: (.+)\n/.exec(block);
    if (header && header[2].trim() === type) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
    }
  }
  return null;
}

async function waitFor<T>(fn: () => T | null, label: string, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("interactive mode", () => {
  it("asks a question over SSE and resumes on answer", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: interactiveAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);

    const sse = openSse(`${url}/v1/sessions/${sid}/events`);
    try {
      const submitted = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
        method: "POST",
        json: { input: "hi", mode: "interactive" },
      });
      const jobId = submitted.json.jobId as string;

      const question = await waitFor(
        () => parseEvent(sse.text(), "question"),
        "question event",
      );
      const data = question.data as { id: string; text: string; kind: string };
      expect(data.kind).toBe("text");
      expect(data.text).toContain("name");

      const answerRes = await httpJson(`${url}/v1/tasks/${jobId}/answer`, {
        method: "POST",
        json: { id: data.id, answer: "hello" },
      });
      expect(answerRes.status).toBe(202);

      let done: Record<string, unknown> | null = null;
      for (let i = 0; i < 100 && !done; i++) {
        const body = await httpJson(`${url}/v1/tasks/${jobId}`);
        if (body.json.status === "succeeded") done = body.json;
        else await new Promise((r) => setTimeout(r, 10));
      }
      expect(done?.status).toBe("succeeded");
      const result = (done as { result: { text: string } }).result;
      expect(result.text).toBe("answer:hello");
      expect(sse.text()).toContain("task.waiting_input");
    } finally {
      sse.close();
    }
  });

  it("rejects an answer when the task is not waiting", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: fastAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);
    const submitted = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "hi", mode: "job" },
    });
    const jobId = submitted.json.jobId as string;
    for (let i = 0; i < 100; i++) {
      const body = await httpJson(`${url}/v1/tasks/${jobId}`);
      if (body.json.status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const res = await httpJson(`${url}/v1/tasks/${jobId}/answer`, {
      method: "POST",
      json: { id: "q1", answer: "x" },
    });
    expect(res.status).toBe(409);
  });

  it("requires an id and rejects an unknown question id", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: interactiveAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);

    const sse = openSse(`${url}/v1/sessions/${sid}/events`);
    try {
      const submitted = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
        method: "POST",
        json: { input: "hi", mode: "interactive" },
      });
      const jobId = submitted.json.jobId as string;
      await waitFor(() => parseEvent(sse.text(), "question"), "question");

      const noId = await httpJson(`${url}/v1/tasks/${jobId}/answer`, {
        method: "POST",
        json: { answer: "x" },
      });
      expect(noId.status).toBe(400);

      const badId = await httpJson(`${url}/v1/tasks/${jobId}/answer`, {
        method: "POST",
        json: { id: "q-nope", answer: "x" },
      });
      expect(badId.status).toBe(404);
    } finally {
      sse.close();
    }
  });

  it("aborts an interactive task when the event stream closes", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: interactiveAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);

    const sse = openSse(`${url}/v1/sessions/${sid}/events`);
    const submitted = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "hi", mode: "interactive" },
    });
    const jobId = submitted.json.jobId as string;
    await waitFor(() => parseEvent(sse.text(), "question"), "question");
    sse.close();

    let status = "";
    for (let i = 0; i < 100 && status !== "cancelled"; i++) {
      const body = await httpJson(`${url}/v1/tasks/${jobId}`);
      status = body.json.status as string;
      if (status !== "cancelled") await new Promise((r) => setTimeout(r, 10));
    }
    expect(status).toBe("cancelled");
  });
});
