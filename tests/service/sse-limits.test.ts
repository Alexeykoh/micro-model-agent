/**
 * W10.5: readiness кэшируется и ограничен по частоте; SSE ограничен по числу
 * соединений и idle-времени; закрытие одного из подписчиков не отменяет задачу.
 */
import { get } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import type { ServiceDeps } from "../../src/modules/service/state";
import { startAgentService } from "../../src/modules/service/module";
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

function fastAgent(): unknown {
  return {
    async run(): Promise<AgentResult> {
      return { success: true, text: "ok", iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
  };
}

/** Агент, висящий до shutdown (интерактивный ход). */
async function boot(deps: ServiceDeps): Promise<string> {
  const svc = startAgentService(deps);
  stop = svc.stop;
  return await svc.url;
}

function openSse(
  url: string,
): { text: () => string; closed: () => boolean; close: () => void } {
  let buf = "";
  let closed = false;
  const request = get(url, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
    });
    res.on("end", () => {
      closed = true;
    });
    res.on("close", () => {
      closed = true;
    });
  });
  request.on("error", () => {
    closed = true;
  });
  return {
    text: () => buf,
    closed: () => closed,
    close: () => request.destroy(),
  };
}

async function waitFor(pred: () => boolean, label: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("readiness", () => {
  it("caches the provider probe instead of calling it on every request", async () => {
    let calls = 0;
    const url = await boot(
      makeServiceDeps({
        dir,
        agent: fastAgent(),
        preflight: async () => {
          calls++;
          return { ok: true, reason: "ok" };
        },
      }),
    );
    expect((await httpJson(`${url}/v1/ready`)).status).toBe(200);
    expect((await httpJson(`${url}/v1/ready`)).status).toBe(200);
    expect(calls).toBe(1);
  });

  it("rate-limits readiness probes per client (6/min)", async () => {
    const url = await boot(
      makeServiceDeps({
        dir,
        agent: fastAgent(),
        preflight: async () => ({ ok: true, reason: "ok" }),
      }),
    );
    for (let i = 0; i < 6; i++) expect((await httpJson(`${url}/v1/ready`)).status).toBe(200);
    const limited = await httpJson(`${url}/v1/ready`);
    expect(limited.status).toBe(429);
    expect(String(limited.json.type)).toContain("rate-limited");
    expect(Number(limited.json.retry_after_ms)).toBeGreaterThan(0);
  });
});

describe("SSE bounds", () => {
  it("caps concurrent streams", async () => {
    const url = await boot(makeServiceDeps({ dir, agent: fastAgent(), maxSseClients: 1 }));
    const sid = await firstSessionId(url);
    const first = openSse(`${url}/v1/sessions/${sid}/events`);
    try {
      await new Promise((r) => setTimeout(r, 30)); // соединение установлено
      const second = await httpJson(`${url}/v1/sessions/${sid}/events`);
      expect(second.status).toBe(503);
      expect(String(second.json.type)).toContain("rate-limited");
    } finally {
      first.close();
    }
  });

  it("closes a stream that stays idle without events", async () => {
    const url = await boot(
      makeServiceDeps({ dir, agent: fastAgent(), keepaliveMs: 10, sseIdleMs: 40 }),
    );
    const sid = await firstSessionId(url);
    const sse = openSse(`${url}/v1/sessions/${sid}/events`);
    await waitFor(() => sse.closed(), "idle close", 2000);
    expect(sse.closed()).toBe(true);
  });

  it("cancels an interactive task only when the last subscriber closes", async () => {
    let shutdowns = 0;
    const agent = {
      run(): Promise<AgentResult> {
        return new Promise<AgentResult>(() => {});
      },
      setPromptIO() {},
      shutdown() {
        shutdowns++;
      },
    };
    const svc = startAgentService(makeServiceDeps({ dir, agent, keepaliveMs: 10 }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);

    const a = openSse(`${url}/v1/sessions/${sid}/events`);
    const b = openSse(`${url}/v1/sessions/${sid}/events`);
    await waitFor(() => svc.state.clients.size === 2, "two subscribers");
    await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "interactive", mode: "interactive" },
    });
    await waitFor(() => svc.state.tasks.listForSession(sid).some((t) => t.status === "running"), "task running");

    a.close();
    await new Promise((r) => setTimeout(r, 40));
    expect(shutdowns).toBe(0);
    expect(svc.state.tasks.listForSession(sid)[0]?.status).toBe("running");

    b.close();
    await waitFor(() => shutdowns > 0, "cancel on last subscriber");
  });
});
