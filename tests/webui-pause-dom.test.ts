// DOM coverage for the pause button (`session/pause.ts`): visibility follows
// the server-projected running/paused state (INV-P5); the icon-button sits in
// the composer before send, shows pause/play via aria-label, and a click POSTs
// the opposite action to /api/pause.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(
  `<div id="msgs" class="msgs"></div><div class="composer"><div class="composer-main">
   <button class="pause-btn" id="pauseBtn" hidden aria-label="pause"></button>
   <button class="send-btn" id="sendBtn" type="button" aria-label="send">↑</button>
   </div></div>`,
);
(globalThis as unknown as Record<string, unknown>).DOMParser =
  (win as unknown as Record<string, unknown>).DOMParser;

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: { "web.pause.hold": "pause", "web.pause.resume": "resume" },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const pause = await import("../src/modules/webui/assets/js/session/pause.js");

function btn(): HTMLButtonElement {
  return win.document.getElementById("pauseBtn") as unknown as HTMLButtonElement;
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
  btn().classList.remove("paused");
});

describe("pause button in the composer (next to send/stop)", () => {
  it("hidden when the own session is not running", () => {
    mountTab("A");
    pause.refreshPauseButton();
    expect(btn().hidden).toBe(true);

    store.session.runningSessionIds = ["B"]; // a foreign session runs
    pause.refreshPauseButton();
    expect(btn().hidden).toBe(true);
  });

  it("shows the pause icon for a running turn and the play icon once paused", () => {
    mountTab("A");
    store.session.runningSessionIds = ["A"];
    pause.refreshPauseButton();
    expect(btn().hidden).toBe(false);
    expect(btn().getAttribute("aria-label")).toBe("pause");
    expect(btn().querySelector("svg")).not.toBeNull(); // иконка, не текст
    expect(btn().classList.contains("paused")).toBe(false);

    store.session.pausedIds = ["A"];
    pause.refreshPauseButton();
    expect(btn().getAttribute("aria-label")).toBe("resume");
    expect(btn().classList.contains("paused")).toBe(true);
  });

  it("sits before the send button in the composer row", () => {
    const main = win.document.querySelector(".composer-main");
    const nodes = Array.from(main?.children ?? []).map((n) => n.id);
    expect(nodes).toEqual(["pauseBtn", "sendBtn"]);
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
