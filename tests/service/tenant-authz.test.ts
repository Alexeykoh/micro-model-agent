/**
 * W10.1: тенант процесса — авторитетный источник authz (silo: 1 процесс = 1 тенант).
 *
 * Заголовок `X-Mma-Tenant` не задаёт тенанта, а сверяется с ним: чужой тенант —
 * 403 до маршрута, поэтому ни задачи, ни сессии, ни SSE чужого тенанта не видны.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import type { AppConfig } from "../../src/config/types";
import { startAgentService } from "../../src/modules/service/module";
import type { ServiceDeps } from "../../src/modules/service/state";
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

beforeEach(() => {
  dir = tempServiceDir();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

function deps(patch?: (c: AppConfig) => void): ServiceDeps {
  return makeServiceDeps({ dir, agent: fastAgent("ok"), ...(patch ? { patch } : {}) });
}

async function boot(patch?: (c: AppConfig) => void): Promise<string> {
  const svc = startAgentService(deps(patch));
  stop = svc.stop;
  return await svc.url;
}

const acme = (c: AppConfig) => {
  c.service.tenant = "acme";
};

describe("tenant authz (silo)", () => {
  it("rejects a foreign X-Mma-Tenant before any route runs", async () => {
    const url = await boot(acme);
    const foreign = { "X-Mma-Tenant": "globex" };
    const sid = await firstSessionId(url);

    expect((await httpJson(`${url}/v1/sessions`, { headers: foreign })).status).toBe(403);
    expect((await httpJson(`${url}/v1/sessions/${sid}`, { headers: foreign })).status).toBe(403);
    expect((await httpJson(`${url}/v1/tasks/job_x`, { headers: foreign })).status).toBe(403);
    expect(
      (
        await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
          method: "POST",
          json: { input: "x", mode: "job" },
          headers: foreign,
        })
      ).status,
    ).toBe(403);
    expect(
      (await httpJson(`${url}/v1/sessions/${sid}/events`, { headers: foreign })).status,
    ).toBe(403);
  });

  it("accepts the process tenant both explicitly and by omission", async () => {
    const url = await boot(acme);
    const explicit = await httpJson(`${url}/v1/sessions`, {
      headers: { "X-Mma-Tenant": "acme" },
    });
    expect(explicit.status).toBe(200);
    expect((await httpJson(`${url}/v1/sessions`)).status).toBe(200);

    const sid = await firstSessionId(url);
    const submitted = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "x", mode: "job", wait: true },
      headers: { "X-Mma-Tenant": "acme" },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.json.status).toBe("succeeded");
    const read = await httpJson(`${url}/v1/tasks/${submitted.json.jobId}`, {
      headers: { "X-Mma-Tenant": "acme" },
    });
    expect(read.status).toBe(200);
  });

  it("does not accept a tenant header when the process has no tenant", async () => {
    const url = await boot();
    const res = await httpJson(`${url}/v1/sessions`, { headers: { "X-Mma-Tenant": "acme" } });
    expect(res.status).toBe(403);
    expect((await httpJson(`${url}/v1/sessions`)).status).toBe(200);
  });

  it("records the process tenant in the session log even without the header", async () => {
    const url = await boot(acme);
    const sid = await firstSessionId(url);
    await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "x", mode: "job", wait: true },
    });
    const entries = readFileSync(join(dir, sid, "session.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const serviceTask = entries.find((e) => e.type === "service_task");
    expect(serviceTask?.tenantId).toBe("acme");
  });

  it("404s a task owned by another tenant even inside the same process", async () => {
    const svc = startAgentService(deps(acme));
    stop = svc.stop;
    const url = await svc.url;
    const foreign = svc.state.tasks.create({
      sessionId: (await firstSessionId(url)),
      mode: "job",
      input: "secret",
      tenant: { tenantId: "globex" },
    });
    const res = await httpJson(`${url}/v1/tasks/${foreign.jobId}`);
    expect(res.status).toBe(404);
  });
});
