import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { createWebUiState } from "../src/modules/webui/state";
import { makeWebCommands } from "../src/modules/webui/chat/commands";
import { withServer, doFetch } from "./helpers/webui-server";

/**
 * Вывод slash-команды попадает в ленту своей вкладки, а ошибка команды видна
 * пользователю (аудит §6.10/§6.17, план
 * `2026-10-12-harness-module-audit-fixes`, W6/Task 6.8).
 */

function fakeClient(chunks: string[]): ServerResponse {
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {},
  } as unknown as ServerResponse;
}

describe("webui: вывод slash-команды", () => {
  it("a command typed in a background tab renders in that tab", async () => {
    const s = createWebUiState();
    const chunks: string[] = [];
    s.clients.add(fakeClient(chunks));
    // Вкладка «b» — не активная на сервере, но команда выполнена под ней.
    s.activeSessionId = "b";

    const dispatch = makeWebCommands({ state: s });
    await dispatch("/help");

    const events = chunks.join("");
    expect(events).toContain("event: command");
    expect(events).toContain('"sessionId":"b"');
  });

  it("a failing command shows an error line in the session", async () => {
    const s = createWebUiState();
    const chunks: string[] = [];
    s.clients.add(fakeClient(chunks));
    s.sessionManager = {
      list: () => [],
      get: (id: string) => ({ id }) as never,
      getActive: () => "a",
      setActive: () => {},
      delete: () => {},
    } as never;
    s.bridge = {
      isBusy: () => false,
      submit: () => Promise.resolve(),
      interrupt: () => {},
      getState: () => ({ busy: false }),
      executeCommand: () => Promise.reject(new Error("command exploded")),
    } as never;

    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "a", line: "/memory get nope" }),
      });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 20));
    });

    const events = chunks.join("");
    expect(events).toContain("event: error");
    expect(events).toContain("command exploded");
    expect(events).toContain('"sessionId":"a"');
  });
});
