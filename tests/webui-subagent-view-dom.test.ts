// DOM-контур вида субагента: клик по строке, живой рендер, возврат без потери
// родительской ленты (TODO §1.1, спека 2026-10-23-subagent-run-view-design).
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div class="chat"><div id="msgs" class="msgs"></div></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };

const store = await import("../src/modules/webui/assets/js/store.js");
const core = await import("../src/modules/webui/assets/js/feed/core.js");
const sub = await import("../src/modules/webui/assets/js/feed/subagent.js");

function mountTab(id: string): { feed: HTMLElement; row: HTMLElement } {
  const feed = win.document.createElement("div") as HTMLElement;
  feed.className = "feed";
  const row = win.document.createElement("div") as HTMLElement;
  row.className = "act run";
  row.dataset.toolCallId = "call_1";
  feed.appendChild(row);
  win.document.querySelector("#msgs")!.appendChild(feed);
  store.tabs.tabs.push({ id, feed, kind: "session" });
  store.tabs.activeTabId = id;
  store.tabs.liveTabId = id;
  return { feed, row };
}

function ev(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "subagent",
    sessionId: "S1",
    runId: "r1",
    ...extra,
  };
}

describe("subagent run view", () => {
  it("marks the row, opens on click, streams and returns to the same feed", () => {
    const { feed, row } = mountTab("S1");
    sub.initSubagentView();

    sub.onSubagentEvent(
      ev({
        kind: "start",
        seq: 1,
        parentToolCallId: "call_1",
        task: "survey the repo",
        depth: 1,
        startedAt: Date.now(),
      }),
    );
    expect(row.dataset.runId).toBe("r1");
    expect(row.classList.contains("srun-link")).toBe(true);

    row.click();
    expect(win.document.querySelector("#msgs .srun")).toBeTruthy();
    expect(core.activeFeed()).toBeNull();

    // Родительская лента detached, но живая: события продолжают копиться.
    const later = win.document.createElement("div");
    later.className = "act";
    core.appendTo(feed, later);
    expect(feed.contains(later)).toBe(true);

    sub.onSubagentEvent(ev({ kind: "text", seq: 2, chunk: "hello " }));
    sub.onSubagentEvent(ev({ kind: "text", seq: 3, chunk: "world" }));

    sub.onSubagentEvent(ev({ kind: "end", seq: 4, status: "done", iterations: 2, durationMs: 1500 }));
    // Стриминговый Markdown держит недописанную строку до flush — конец
    // сегмента (end прогона) её отдаёт.
    const body = win.document.querySelector(".srun-body");
    expect(body?.textContent).toContain("hello world");
    expect(win.document.querySelector(".srun-state")?.classList.contains("st-done")).toBe(true);

    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(win.document.querySelector("#msgs .srun")).toBeNull();
    expect(win.document.querySelector("#msgs")?.firstChild).toBe(feed);
    expect(core.activeFeed()).toBe(feed);
  });

  it("switches between two runs without leaving the view", () => {
    const { row } = mountTab("S2");
    store.tabs.tabs = store.tabs.tabs.filter((t) => t.id !== "S1");
    row.dataset.toolCallId = "call_2";
    sub.onSubagentEvent(
      ev({
        kind: "start",
        sessionId: "S2",
        runId: "a",
        seq: 1,
        parentToolCallId: "call_2",
        task: "first",
        depth: 1,
        startedAt: 1000,
      }),
    );
    sub.onSubagentEvent(
      ev({
        kind: "start",
        sessionId: "S2",
        runId: "b",
        seq: 1,
        parentToolCallId: "call_3",
        task: "second",
        depth: 1,
        startedAt: 2000,
      }),
    );
    row.click();
    expect(win.document.querySelector(".srun-title")?.textContent).toBe("first");
    const chips = win.document.querySelectorAll(".srun-chip");
    expect(chips.length).toBe(2);
    (chips[1] as HTMLElement).click();
    expect(win.document.querySelector(".srun-title")?.textContent).toBe("second");
    expect(win.document.querySelectorAll(".srun").length).toBe(1);
  });
});
