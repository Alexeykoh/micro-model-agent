import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, doFetch } from "./helpers/webui-server";

/**
 * Троттл POST — на сессию: параллельные вкладки не отвергают друг друга
 * (аудит §6.9, план `2026-10-12-harness-module-audit-fixes`, W6/Task 6.4).
 */

function stateWithSessions(ids: string[]): ReturnType<typeof createWebUiState> {
  const s = createWebUiState();
  s.minPostIntervalMs = 60_000;
  s.sessionManager = {
    list: () => [],
    get: (id: string) => (ids.includes(id) ? ({ id } as never) : null),
    getActive: () => ids[0] ?? null,
    setActive: () => {},
    delete: () => {},
  } as never;
  s.pool.setFactory(
    (id: string) =>
      ({
        sessionId: id,
        agent: { run: () => new Promise(() => {}), shutdown: () => {} },
        contextManager: { addPendingImage: () => {} },
        execModule: { getActivePlan: () => null },
      }) as never,
  );
  return s;
}

async function post(base: string, sessionId: string): Promise<number> {
  const res = await doFetch(`${base}/api/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hi", sessionId }),
  });
  return res.status;
}

describe("webui: троттл по сессиям", () => {
  it("parallel sessions are not rate-limited against each other", async () => {
    const s = stateWithSessions(["A", "B"]);
    await withServer(s, async (base) => {
      expect(await post(base, "A")).toBe(202);
      expect(await post(base, "B")).toBe(202);
    });
  });

  it("a second post to the same session within the interval is rejected", async () => {
    const s = stateWithSessions(["A"]);
    await withServer(s, async (base) => {
      expect(await post(base, "A")).toBe(202);
      expect(await post(base, "A")).toBe(429);
    });
  });
});
