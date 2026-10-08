import { get, type ClientRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import { httpJson } from "./http-client";
import {
  cleanupServiceDir,
  firstSessionId,
  makeServiceDeps,
  tempServiceDir,
  waitTaskStatus,
} from "./harness";

let dir: string;
let stop: (() => void) | undefined;
const gates: Array<() => void> = [];

function slowAgent() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  gates.push(release);
  return {
    agent: {
      async run(_i: string, onChunk?: (c: string) => void): Promise<AgentResult> {
        await gate;
        onChunk?.("payload");
        return { success: true, text: "payload", iterationCount: 1 };
      },
      shutdown() {},
    },
    release,
  };
}

function fastAgent() {
  return {
    async run(_i: string, onChunk?: (c: string) => void): Promise<AgentResult> {
      onChunk?.("quick");
      return { success: true, text: "quick", iterationCount: 1 };
    },
    shutdown() {},
  };
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

function openSse(
  url: string,
  headers: Record<string, string> = {},
): { text: () => string; close: () => void; request: ClientRequest } {
  let buf = "";
  const request = get(url, { headers }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
    });
  });
  return { text: () => buf, close: () => request.destroy(), request };
}

async function waitFor(pred: () => boolean, label: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("events api", () => {
  it("streams live task events over SSE", async () => {
    const slow = slowAgent();
    const svc = startAgentService(makeServiceDeps({ dir, agent: slow.agent }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);

    const sse = openSse(`${url}/v1/sessions/${sid}/events`);
    try {
      await httpJson(`${url}/v1/sessions/${sid}/tasks`, { method: "POST", json: { input: "go", mode: "job" } });
      await waitFor(() => sse.text().includes("event: task.started"), "task.started");
      slow.release();
      await waitFor(() => sse.text().includes("event: task.finished"), "task.finished");
      expect(sse.text()).toContain("event: text.delta");
      expect(sse.text()).toContain("event: task.started");
    } finally {
      sse.close();
    }
  });

  it("replays buffered events on resume (since=0)", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: fastAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);
    const submitted = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "go", mode: "job" },
    });
    const jobId = submitted.json.jobId as string;
    await waitTaskStatus(url, jobId, "succeeded");

    const sse = openSse(`${url}/v1/sessions/${sid}/events?since=0`);
    try {
      await waitFor(() => sse.text().includes("event: task.finished"), "replayed task.finished");
      expect(sse.text()).toContain("event: task.started");
      expect(sse.text()).toMatch(/id: \d+/);
    } finally {
      sse.close();
    }
  });

  it("resumes from the Last-Event-ID header", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: fastAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);
    const submitted = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "go", mode: "job" },
    });
    const jobId = submitted.json.jobId as string;
    await waitTaskStatus(url, jobId, "succeeded");

    const sse = openSse(`${url}/v1/sessions/${sid}/events`, { "Last-Event-ID": "1" });
    try {
      await waitFor(() => sse.text().includes("event: task.finished"), "resume task.finished");
      expect(sse.text()).not.toContain("id: 1\nevent:");
      expect(sse.text()).toContain("id: 2\nevent:");
    } finally {
      sse.close();
    }
  });

  it("emits keep-alive pings", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: fastAgent(), keepaliveMs: 20 }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);
    const sse = openSse(`${url}/v1/sessions/${sid}/events`);
    try {
      await waitFor(() => sse.text().includes(": ping"), "keep-alive ping");
    } finally {
      sse.close();
    }
  });

  it("keeps a job running when the event stream closes", async () => {
    const slow = slowAgent();
    const svc = startAgentService(makeServiceDeps({ dir, agent: slow.agent }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);
    const sse = openSse(`${url}/v1/sessions/${sid}/events`);
    const submitted = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "go", mode: "job" },
    });
    const jobId = submitted.json.jobId as string;
    await waitFor(() => sse.text().includes("event: task.started"), "task.started");
    sse.close();

    await new Promise((r) => setTimeout(r, 40));
    const mid = await httpJson(`${url}/v1/tasks/${jobId}`);
    expect(mid.json.status).toBe("running");

    slow.release();
    await waitTaskStatus(url, jobId, "succeeded");
  });

  it("404s events for an unknown session", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: fastAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const res = await httpJson(`${url}/v1/sessions/ses_missing/events`);
    expect(res.status).toBe(404);
  });
});
