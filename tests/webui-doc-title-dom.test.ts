// DOM coverage for the browser-tab title (`session/tabs-strip.ts`): the tab
// shows the active chat's name and follows it when the name changes (server
// auto-naming arrives via updateTabName → renderTabstrip) or when another tab
// becomes active.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

// Композер и его листья захватывают узлы при импорте (`inp`, attach-btn,
// img-picker) — харнес обязан дать всю строку ввода, иначе модуль упадёт до
// первого теста.
const win = setupHappyDom(
  `<div id="msgs" class="msgs"></div><div class="tabstrip" id="tabstrip"></div>` +
    `<div class="composer"><div class="composer-main">` +
    `<button class="attach-btn" id="attachBtn" type="button"></button>` +
    `<textarea id="inp"></textarea>` +
    `<button class="pause-btn" id="pauseBtn" hidden></button>` +
    `<button class="send-btn" id="sendBtn" type="button"></button>` +
    `</div></div><input type="file" id="imgPicker" hidden>`,
);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };

const store = await import("../src/modules/webui/assets/js/store.js");
const strip = await import("../src/modules/webui/assets/js/session/tabs-strip.js");

function mountTab(id: string, name: string, kind = "session"): void {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  store.tabs.tabs.push({ id, name, kind, feed } as never);
}

beforeEach(() => {
  store.tabs.tabs = [];
  store.tabs.activeTabId = null;
});

describe("pageTitle (pure)", () => {
  it("falls back to the app title without a session tab", () => {
    expect(strip.pageTitle(null)).toBe("MMA Web");
    expect(strip.pageTitle({ kind: "new", name: "" })).toBe("MMA Web");
    expect(strip.pageTitle({ kind: "session", name: "   " })).toBe("MMA Web");
  });

  it("uses the chat name for a live session tab", () => {
    expect(strip.pageTitle({ kind: "session", name: "Погода в Москве" })).toBe(
      "Погода в Москве · MMA",
    );
  });

  it("a dead tab (session gone) does not name the window", () => {
    expect(strip.pageTitle({ kind: "session", name: "gone", dead: true })).toBe("MMA Web");
  });
});

describe("document.title follows the active tab", () => {
  it("renders the strip and sets the title from the active session", () => {
    mountTab("A", "Первый чат");
    mountTab("B", "Второй чат");
    store.tabs.activeTabId = "A";
    strip.renderTabstrip();
    expect(document.title).toBe("Первый чат · MMA");

    // Переключение активной вкладки — тот же путь перерисовки.
    store.tabs.activeTabId = "B";
    strip.renderTabstrip();
    expect(document.title).toBe("Второй чат · MMA");
  });

  it("renaming the active chat updates the title", () => {
    mountTab("A", "derive-name");
    store.tabs.activeTabId = "A";
    strip.renderTabstrip();
    expect(document.title).toBe("derive-name · MMA");

    // Серверный автонейминг приходит в модель именно так (updateTabName),
    // затем полоска перерисовывается.
    store.tabs.tabs[0].name = "Погода и цены";
    strip.renderTabstrip();
    expect(document.title).toBe("Погода и цены · MMA");
  });
});
