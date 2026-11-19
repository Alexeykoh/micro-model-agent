// REST-контур прогонов субагентов: 200 снимки, фильтр по tool call, 404/503.
import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { doFetch, withServer } from "./helpers/webui-server";
import type { SubagentRunEvent } from "../src/tools/subagent-runs";

const start: SubagentRunEvent = {
  kind: "start",
  runId: "r1",
  parentSessionId: "S1",
  parentToolCallId: "call_1",
  depth: 1,
  task: "survey",
  at: 1000,
};

function withSession() {
  const s = createWebUiState();
  s.sessionManager = {
    list: () => [],
    get: (id: string) => (id === "S1" ? ({ id } as never) : null),
    getActive: () => null,
    setActive: () => {},
    delete: () => {},
  };
  s.subagentRuns.ingest(start, () => {});
  s.subagentRuns.ingest(
    { kind: "start", runId: "r2", parentSessionId: "S1", parentToolCallId: "call_2", depth: 1, task: "b", at: 2000 },
    () => {},
  );
  return s;
}

async function getJson(base: string, path: string) {
  const res = await doFetch(base + path);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/sessions/:id/subagents", () => {
  it("returns snapshots for the session", async () => {
    const s = withSession();
    await withServer(s, async (base) => {
      const r = await getJson(base, "/api/sessions/S1/subagents");
      expect(r.status).toBe(200);
      const runs = r.json.runs as Array<Record<string, unknown>>;
      expect(runs.map((x) => x.runId)).toEqual(["r1", "r2"]);
      expect(runs[0].task).toBe("survey");
      expect(Array.isArray(runs[0].events)).toBe(true);
    });
  });

  it("filters by parent tool call id", async () => {
    const s = withSession();
    await withServer(s, async (base) => {
      const r = await getJson(base, "/api/sessions/S1/subagents?toolCallId=call_2");
      const runs = r.json.runs as Array<Record<string, unknown>>;
      expect(runs.map((x) => x.runId)).toEqual(["r2"]);
    });
  });

  it("returns 404 for an unknown session and 503 without a manager", async () => {
    const s = withSession();
    await withServer(s, async (base) => {
      expect((await getJson(base, "/api/sessions/nope/subagents")).status).toBe(404);
    });
    s.sessionManager = undefined;
    await withServer(s, async (base) => {
      expect((await getJson(base, "/api/sessions/S1/subagents")).status).toBe(503);
    });
  });

  it("stops a running run via POST interrupt", async () => {
    const s = withSession();
    let stopped = 0;
    s.subagentRuns.sink(() => {}).registerInterrupt?.("r1", () => {
      stopped++;
    });
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions/S1/subagents/r1/interrupt`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(stopped).toBe(1);
      const missing = await doFetch(`${base}/api/sessions/S1/subagents/nope/interrupt`, {
        method: "POST",
      });
      expect(missing.status).toBe(404);
    });
  });
});
