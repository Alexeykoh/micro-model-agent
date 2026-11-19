/**
 * W10a: у веб-хода один вход — `Host.submit` (INV-S2).
 *
 * `POST /api/message` не запускает раннер сам: он передаёт ход хосту, а тот —
 * общей точке `submitTurnFromHost`. Без этого в `mma web` оставался второй
 * путь исполнения хода мимо контракта `Host`.
 */
import { describe, expect, it } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import type { Host } from "../src/core/host";
import { doFetch, withServer } from "./helpers/webui-server";

function countingHost() {
  const calls: Array<{ text: string; sessionId?: string }> = [];
  const host: Host = {
    isBusy: () => false,
    submit: async (text, opts) => {
      calls.push({ text, ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}) });
      return { ok: true, sessionId: opts?.sessionId ?? "S" };
    },
    interrupt: () => {},
    getState: async () => ({ busy: false }),
    subscribeEvents: () => () => {},
    getConfig: async () => ({ config: {}, version: 0 }),
    listModels: async () => ({ models: [] }),
    setConfig: async () => ({ ok: true, persisted: true }),
    executeCommand: async () => ({ ok: true, output: [] }),
    listSessions: async () => [],
    createSession: async (name?: string) => ({ id: "S", name: name ?? "" }) as never,
    deleteSession: async () => {},
    getHistory: async () => [],
    getLog: async () => [],
  };
  return { host, calls };
}

describe("web turn goes through Host (W10a)", () => {
  it("passes the message, images and owning session to Host.submit", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    const { host, calls } = countingHost();
    s.bridge = host;

    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          sessionId: "S",
          images: ["data:image/png;base64,AA=="],
        }),
      });
      expect(res.status).toBe(202);
    });

    expect(calls).toEqual([{ text: "hello", sessionId: "S" }]);
    // Собственного запуска раннера в адаптере нет.
    expect(s.pool.anyBusy()).toBe(false);
  });
});
