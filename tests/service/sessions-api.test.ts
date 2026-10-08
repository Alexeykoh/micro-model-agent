import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAgentService } from "../../src/modules/service/module";
import { httpJson } from "./http-client";
import { cleanupServiceDir, makeServiceDeps, tempServiceDir } from "./harness";

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

async function boot(): Promise<string> {
  const svc = startAgentService(makeServiceDeps({ dir }));
  stop = svc.stop;
  return await svc.url;
}

describe("sessions api", () => {
  it("creates a session with externalRef", async () => {
    const url = await boot();
    const res = await httpJson(`${url}/v1/sessions`, {
      method: "POST",
      json: { name: "chat-1", externalRef: "chat:42" },
    });
    expect(res.status).toBe(201);
    expect(String(res.json.id)).toMatch(/^ses_/);
    expect(res.json.externalRef).toBe("chat:42");
    expect(res.json.status).toBe("idle");
  });

  it("lists and filters by externalRef", async () => {
    const url = await boot();
    await httpJson(`${url}/v1/sessions`, { method: "POST", json: { externalRef: "keep" } });
    await httpJson(`${url}/v1/sessions`, { method: "POST", json: { externalRef: "drop" } });
    const res = await httpJson(`${url}/v1/sessions?externalRef=keep`);
    expect(res.status).toBe(200);
    const sessions = res.json.sessions as Array<{ externalRef: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].externalRef).toBe("keep");
  });

  it("gets and deletes a session", async () => {
    const url = await boot();
    const created = await httpJson(`${url}/v1/sessions`, { method: "POST", json: {} });
    const id = created.json.id as string;

    const got = await httpJson(`${url}/v1/sessions/${id}`);
    expect(got.status).toBe(200);

    const del = await httpJson(`${url}/v1/sessions/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    const gone = await httpJson(`${url}/v1/sessions/${id}`);
    expect(gone.status).toBe(404);
    expect(String(gone.headers["content-type"])).toContain("application/problem+json");
  });

  it("404s an unknown session", async () => {
    const url = await boot();
    const res = await httpJson(`${url}/v1/sessions/ses_missing`);
    expect(res.status).toBe(404);
  });
});
