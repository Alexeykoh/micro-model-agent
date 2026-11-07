// `POST /api/pause` + проекция `pausedIds` в состоянии (спека webui-pause-resume).
import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, postJson, doFetch } from "./helpers/webui-server";

interface StubAgent {
  paused: boolean;
  pauses: number;
  resumes: number;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  shutdown(): void;
}

function makeFixture() {
  const agents = new Map<string, StubAgent>();
  const s = createWebUiState();
  s.minPostIntervalMs = 0;
  s.pool.setFactory((id: string) => {
    const agent: StubAgent = {
      paused: false,
      pauses: 0,
      resumes: 0,
      pause() {
        this.paused = true;
        this.pauses++;
      },
      resume() {
        this.paused = false;
        this.resumes++;
      },
      isPaused: () => agent.paused,
      shutdown: () => {},
    };
    agents.set(id, agent);
    return {
      sessionId: id,
      agent: agent as never,
      contextManager: { addPendingImage: () => {} },
      execModule: { getActivePlan: () => null },
    } as never;
  });
  return { s, agents };
}

/** Резервирует слот и спавнит раннера (эмулирует идущий ход). */
function startSlot(s: ReturnType<typeof makeFixture>["s"], id: string): object {
  s.pool.getOrCreateRunner(id);
  return s.pool.reserve(id);
}

async function getState(base: string): Promise<Record<string, unknown>> {
  return (await (await doFetch(`${base}/api/state`)).json()) as Record<string, unknown>;
}

describe("POST /api/pause", () => {
  it("rejects an unknown action with 400", async () => {
    const { s } = makeFixture();
    await withServer(s, async (base) => {
      const r = await postJson(base, "/api/pause", { sessionId: "A", action: "hold" });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("bad_request");
    });
  });

  it("rejects an idle session with 409 (same contract as /api/interrupt, INV-P5)", async () => {
    const { s } = makeFixture();
    await withServer(s, async (base) => {
      const r = await postJson(base, "/api/pause", { sessionId: "A", action: "pause" });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("idle");
    });
  });

  it("pauses a running slot and projects pausedIds into the state", async () => {
    const { s, agents } = makeFixture();
    startSlot(s, "A");
    await withServer(s, async (base) => {
      const r = await postJson(base, "/api/pause", { sessionId: "A", action: "pause" });
      expect(r.status).toBe(200);
      expect(agents.get("A")?.paused).toBe(true);
      const state = await getState(base);
      expect(state.pausedIds).toEqual(["A"]);
      expect(state.runningSessionIds).toContain("A");

      const resume = await postJson(base, "/api/pause", { sessionId: "A", action: "resume" });
      expect(resume.status).toBe(200);
      expect(agents.get("A")?.paused).toBe(false);
      expect((await getState(base)).pausedIds).toEqual([]);
    });
  });

  it("without sessionId applies to every running slot; resume is idempotent", async () => {
    const { s, agents } = makeFixture();
    startSlot(s, "A");
    startSlot(s, "B");
    await withServer(s, async (base) => {
      const r = await postJson(base, "/api/pause", { action: "pause" });
      expect(r.status).toBe(200);
      expect(agents.get("A")?.paused).toBe(true);
      expect(agents.get("B")?.paused).toBe(true);
      expect(((await getState(base)).pausedIds as string[]).sort()).toEqual(["A", "B"]);

      // Second resume (race with a double click) must not error.
      const again = await postJson(base, "/api/pause", { sessionId: "A", action: "resume" });
      expect(again.status).toBe(200);
    });
  });

  it("stop wakes a paused turn (INV-P3 insurance)", async () => {
    const { s, agents } = makeFixture();
    startSlot(s, "A");
    await withServer(s, async (base) => {
      await postJson(base, "/api/pause", { sessionId: "A", action: "pause" });
      const stop = await postJson(base, "/api/interrupt", { sessionId: "A" });
      expect(stop.status).toBe(200);
      expect(agents.get("A")?.resumes).toBeGreaterThanOrEqual(1);
      expect((await getState(base)).pausedIds).toEqual([]);
    });
  });
});
