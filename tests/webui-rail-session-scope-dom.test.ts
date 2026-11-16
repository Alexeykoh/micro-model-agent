// Regression: рельс активности — оконный хром ОДНОЙ вкладки.
//
// Параллельный ход фоновой сессии показывался в свежем «Новом чате» как его
// собственная работа («думаю · 5.6s» в пустой ленте): рельс брал `busy` из
// глобального флага и падал на «последнюю активную сессию», а счётчики/план
// складывались из событий ВСЕХ сессий. Пользователь читал это как «агент не
// умеет вести параллельные сессии».
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`
  <div id="msgs" class="msgs"></div>
  <div class="input-area">
    <div class="rail-wrap l-line" id="railWrap">
      <div class="rail-l1">
        <span class="lab"></span><span class="time"></span><span class="speed"></span>
        <span class="st"></span><span class="right"></span>
      </div>
      <div class="rl-track"><div class="rl-fill"></div><div class="rl-notches"></div></div>
      <div class="rail-l2">
        <span class="tools"></span><span class="events"></span><span class="last" hidden></span>
      </div>
    </div>
    <div class="selectors"></div>
  </div>
`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.action.thinking": "thinking",
    "web.rail.composing": "composing",
    "web.rail.working": "working",
    "web.rail.no_plan": "no plan",
    "web.rail.step_of": "step {cur}/{total}",
    "web.rail.last": "last:",
    "web.rail.tools_one": "{count} tool",
    "web.rail.tools_many": "{count} tools",
    "web.rail.tools_few": "{count} tools",
    "web.rail.events_one": "{count} event",
    "web.rail.events_many": "{count} events",
    "web.rail.events_few": "{count} events",
    "web.input.esc": "Esc — stop",
  },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const rail = await import("../src/modules/webui/assets/js/rail.js");
const activity = await import("../src/modules/webui/assets/js/core/activity.js");

function mountTab(id: string): void {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, kind: "session", feed });
}

function railRoot(): HTMLElement {
  return win.document.getElementById("railWrap") as HTMLElement;
}
function text(selector: string): string {
  return win.document.querySelector(`#railWrap ${selector}`)?.textContent || "";
}

describe("рельс показывает только активную вкладку", () => {
  beforeEach(() => {
    store.tabs.tabs = [];
    store.session.activeSessionId = null;
    store.session.runningSessionIds = [];
    store.session.busy = false;
    rail.initRail("line");
    rail.setBusy(false);
  });
  afterEach(() => rail.setBusy(false));

  it("не показывает «думаю» фонового чата в свежей вкладке", () => {
    mountTab("scope-BG");
    mountTab("scope-NEW");
    store.session.activeSessionId = "scope-NEW";
    store.session.runningSessionIds = ["scope-BG"];
    store.session.busy = true;
    // Фоновый чат реально работает: у него идёт фаза и уже были тулы.
    activity.activityStart("scope-BG", Date.now() - 5600);
    rail.railEvent("tool_start", "bash", "scope-BG");
    rail.railEvent("tool_end", "bash", "scope-BG");
    // Свежая вкладка idle: reflectBusy() отдаёт в рельс её собственный ход.
    rail.setBusy(false);

    expect(railRoot().hidden).toBe(true);
    expect(text(".lab")).toBe("");
    expect(text(".time")).toBe("");
  });

  it("считает тулы и события только своей сессии", () => {
    mountTab("scope-A");
    mountTab("scope-B");
    store.session.activeSessionId = "scope-A";
    store.session.runningSessionIds = ["scope-A", "scope-B"];
    rail.setBusy(true);

    rail.railEvent("tool_end", "bash", "scope-B");
    rail.railEvent("tool_end", "bash", "scope-A");
    rail.railEvent("text", "", "scope-B");

    expect(text(".tools")).toBe("1 tool");
    expect(text(".events")).toBe("1 event");
    expect(text(".last")).toContain("last:");
  });

  it("копит числа фоновой сессии, но не рисует их", () => {
    mountTab("scope-BG3");
    mountTab("scope-NEW3");
    store.session.activeSessionId = "scope-BG3";
    store.session.runningSessionIds = ["scope-BG3", "scope-NEW3"];
    rail.setBusy(true);

    rail.railEvent("tool_end", "bash", "scope-NEW3");
    rail.railEvent("tool_end", "read_file", "scope-NEW3");
    expect(text(".tools")).toBe("0 tools");

    // Возврат в её вкладку — полная картина своего хода, не ноль.
    store.session.activeSessionId = "scope-NEW3";
    rail.setBusy(false);
    rail.setBusy(true);
    expect(text(".tools")).toBe("2 tools");
  });

  it("конец хода обнуляет его числа у фоновой вкладки", () => {
    mountTab("scope-BG4");
    mountTab("scope-NEW4");
    store.session.activeSessionId = "scope-NEW4";
    store.session.runningSessionIds = ["scope-NEW4", "scope-BG4"];
    rail.setBusy(true);
    rail.railEvent("tool_end", "bash", "scope-BG4");
    rail.setPlan({ steps: [{ text: "one", status: "done" }] }, "scope-BG4");
    rail.railTurnEnd("scope-BG4");
    rail.railTurnEnd("scope-NEW4");

    store.session.activeSessionId = "scope-BG4";
    rail.setBusy(false);
    rail.setBusy(true);
    expect(text(".tools")).toBe("0 tools");
    expect(text(".st")).toBe("no plan");
  });

  it("не подставляет план другой сессии", () => {
    mountTab("scope-BG2");
    mountTab("scope-NEW2");
    rail.setPlan({ steps: [{ text: "one", status: "done" }] }, "scope-BG2");
    store.session.activeSessionId = "scope-NEW2";
    store.session.runningSessionIds = ["scope-NEW2"];
    rail.setBusy(true);

    expect(text(".st")).toBe("no plan");
    expect(text(".tools")).toBe("0 tools");
  });

  it("смена вкладки переключает фото хода на её сессию", () => {
    mountTab("scope-S1");
    mountTab("scope-S2");
    activity.activityStart("scope-S1", Date.now() - 5000);
    activity.activityStart("scope-S2", Date.now() - 1000);

    store.session.activeSessionId = "scope-S1";
    store.session.runningSessionIds = ["scope-S1", "scope-S2"];
    rail.setBusy(true);
    expect(text(".time")).toBe("5.0s");

    store.session.activeSessionId = "scope-S2";
    rail.setBusy(false);
    rail.setBusy(true);
    expect(text(".time")).toBe("1.0s");
  });
});

