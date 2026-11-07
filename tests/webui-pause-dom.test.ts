// DOM coverage for the pause button (`session/pause.ts`): visibility follows
// the server-projected running/paused state (INV-P5), a click POSTs the
// opposite action to /api/pause.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(
  `<div id="msgs" class="msgs"></div><div class="rail-wrap" id="railWrap"><div class="rail-l1">
   <button class="rail-pause" id="railPause" hidden></button></div></div>`,
);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: { "web.pause.hold": "pause", "web.pause.resume": "resume" },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const pause = await import("../src/modules/webui/assets/js/session/pause.js");

function btn(): HTMLButtonElement {
  return win.document.getElementById("railPause") as unknown as HTMLButtonElement;
}

function mountTab(id: string): void {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  store.tabs.tabs.push({ id, kind: "session", feed } as never);
  store.tabs.activeTabId = id;
}

beforeEach(() => {
  store.tabs.tabs = [];
  store.tabs.activeTabId = null;
  store.session.runningSessionIds = [];
  store.session.pausedIds = [];
  btn().hidden = true;
  btn().replaceChildren();
});

describe("pause button in the rail", () => {
  it("hidden when the own session is not running", () => {
    mountTab("A");
    pause.refreshPauseButton();
    expect(btn().hidden).toBe(true);

    store.session.runningSessionIds = ["B"]; // a foreign session runs
    pause.refreshPauseButton();
    expect(btn().hidden).toBe(true);
  });

  it("shows pause for a running turn and resume once the server reports it paused", () => {
    mountTab("A");
    store.session.runningSessionIds = ["A"];
    pause.refreshPauseButton();
    expect(btn().hidden).toBe(false);
    expect(btn().textContent).toContain("pause");

    store.session.pausedIds = ["A"];
    pause.refreshPauseButton();
    expect(btn().textContent).toContain("resume");
  });

  it("click posts the opposite action for the active session", async () => {
    mountTab("A");
    store.session.runningSessionIds = ["A"];
    const calls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      calls.push(init ? JSON.parse(String(init.body)) : {});
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    }) as unknown as typeof globalThis.fetch;
    // toggle() асинхронный: ждём микротасков после клика, иначе fetch-мока
    // ещё не будет, а кнопка временно disabled.
    const flush = () => new Promise((r) => setTimeout(r, 0));
    try {
      btn().click();
      await flush();
      // Сервер подтвердил паузу проекцией `state` — второй клик обязан дать resume.
      store.session.pausedIds = ["A"];
      pause.refreshPauseButton();
      btn().click();
      await flush();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toEqual([
      { sessionId: "A", action: "pause" },
      { sessionId: "A", action: "resume" },
    ]);
  });
});
