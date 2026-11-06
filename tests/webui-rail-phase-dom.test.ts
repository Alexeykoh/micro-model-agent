// Фаза хода — один источник правды для ленты и рельса.
//
// Раньше строка «думаю» в ленте жила своей фазой и своим таймером, а рельс
// над композером — своими. На длинном ходе они расходились: лента писала
// «думаю», рельс «пишу», а секунды считались от разных стартов.
import { describe, it, expect, afterEach } from "vitest";
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
    "web.input.esc": "Esc — stop",
  },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const busy = await import("../src/modules/webui/assets/js/feed/busy.js");
const rail = await import("../src/modules/webui/assets/js/rail.js");
const activity = await import("../src/modules/webui/assets/js/core/activity.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, kind: "session", feed });
  return feed as HTMLElement;
}

function railLabel(): string {
  const lab = win.document.querySelector("#railWrap .lab");
  return lab ? (lab.textContent || "").replace("✦ ", "") : "";
}

function railTime(): string {
  const time = win.document.querySelector("#railWrap .time");
  return time ? time.textContent || "" : "";
}

function busyLabel(feed: HTMLElement): string {
  const lab = feed.querySelector(".busy .lab");
  return lab ? lab.textContent || "" : "";
}

function busyTime(feed: HTMLElement): string {
  const time = feed.querySelector(".busy .busytime");
  return time ? time.textContent || "" : "";
}

describe("фронтенд: фаза хода одна для ленты и рельса", () => {
  // Рельс живёт на своём таймере: гасим его после каждого теста, иначе
  // интервал остаётся в процессе и сдвигает таймеры соседних тестов.
  afterEach(() => rail.setBusy(false));

  it("лента и рельс показывают одну фазу на длинном ходе", () => {
    const feed = mountTab("S1");
    store.session.activeSessionId = "S1";
    rail.initRail("line");
    rail.setBusy(true);

    // Итерация 1: модель пишет ответ.
    activity.activityNote("S1", "text");
    expect(railLabel()).toBe("composing");

    // Итерация 2: модель снова думает — обе поверхности обязаны сказать
    // «думаю», а не «думаю»/«пишу» (регресс из живого прогона).
    activity.activityNote("S1", "thinking");
    busy.showBusy(feed);
    expect(busyLabel(feed)).toBe("thinking");
    expect(railLabel()).toBe("thinking");

    // Тул работает — обе поверхности показывают одну и ту же фазу.
    activity.activityNote("S1", "tool_start");
    expect(busyLabel(feed)).toBe("working");
    expect(railLabel()).toBe("working");
  });

  it("время хода считается от одного старта", () => {
    const feed = mountTab("S2");
    store.session.activeSessionId = "S2";
    rail.initRail("line");
    rail.setBusy(true);

    activity.activityStart("S2", Date.now() - 5000);
    busy.showBusy(feed);

    expect(railTime()).toBe("5.0s");
    expect(busyTime(feed)).toBe("· 5.0s");
  });

  it("конец хода замеряет часы и сбрасывает фазу", () => {
    activity.activityStart("S3", Date.now() - 1000);
    activity.activityStop("S3");
    const st = activity.activityLookup("S3");
    expect(st?.busy).toBe(false);
    expect(activity.activityPhase("S3")).toBe("thinking");
    // Время замерло, а не обнулилось и не пошло дальше.
    const frozen = activity.activitySeconds("S3");
    expect(frozen).toBeGreaterThan(0.9);
    expect(frozen).toBeLessThan(1.1);
  });
});
