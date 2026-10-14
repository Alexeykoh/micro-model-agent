// DOM coverage for the pinned input-queue strip (`session/queue.ts`): a message
// sent mid-turn is pinned above the composer (not injected into the streaming
// answer) and moved into the transcript when its turn starts.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(
  `<div id="msgs" class="msgs"></div><div id="queueStrip" hidden></div>`,
);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.input.queued": "queued · position {n}",
    "web.queue.unknown": "(queued message)",
  },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const queue = await import("../src/modules/webui/assets/js/session/queue.js");

function strip(): HTMLElement {
  return win.document.getElementById("queueStrip") as HTMLElement;
}

function mountTab(id: string): { id: string; kind: string; feed: HTMLElement } {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  const tab = { id, kind: "session", feed: feed as HTMLElement };
  store.tabs.tabs.push(tab);
  return tab;
}

beforeEach(() => {
  store.tabs.tabs = [];
  store.tabs.activeTabId = null;
  store.session.queued = {};
  strip().replaceChildren();
  strip().hidden = true;
});

describe("pinned input-queue strip", () => {
  it("shows a queued message with its position", () => {
    const tab = mountTab("A");
    store.tabs.activeTabId = "A";
    queue.enqueuePending(tab, { text: "запомни погоду", images: [] });
    queue.renderQueueStrip();

    expect(strip().hidden).toBe(false);
    expect(strip().textContent).toContain("запомни погоду");
    expect(strip().textContent).toContain("queued · position 1");
    expect(strip().querySelectorAll(".queue-item").length).toBe(1);
  });

  it("falls back to a placeholder for entries with no local text", () => {
    mountTab("B");
    store.tabs.activeTabId = "B";
    // The server reports two queued messages, but this client only knows none
    // (e.g. another tab enqueued them, or the page reloaded mid-turn).
    store.session.queued = { B: 2 };
    queue.renderQueueStrip();

    expect(strip().querySelectorAll(".queue-item").length).toBe(2);
    expect(strip().textContent).toContain("(queued message)");
  });

  it("moves the head into the feed on turn_end and drops it from the pin", () => {
    const tab = mountTab("C");
    // Not the active tab: `appendTo` skips the sticky-scroll path, which reads
    // the app-level `#msgs` node (shared module cache across test files).
    store.tabs.activeTabId = null;
    store.session.queued = { C: 2 };
    queue.enqueuePending(tab, { text: "first", images: [] });
    queue.enqueuePending(tab, { text: "second", images: [] });

    queue.drainQueuedTurn("C");

    expect(tab.feed.textContent).toContain("first");
    expect(tab.feed.textContent).not.toContain("second");
  });

  it("hides the strip when nothing is queued", () => {
    mountTab("D");
    store.tabs.activeTabId = "D";
    queue.renderQueueStrip();
    expect(strip().hidden).toBe(true);
  });
});
