// Guard-тесты фронтенда: таймеры закрываемой вкладки, параллельный busy,
// зависший вопрос (аудит §6.14/§6.16, план
// `2026-10-12-harness-module-audit-fixes`, W6/Task 6.7).
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };

const store = await import("../src/modules/webui/assets/js/store.js");
const core = await import("../src/modules/webui/assets/js/feed/core.js");
const turn = await import("../src/modules/webui/assets/js/feed/turn.js");
const storeCore = await import("../src/modules/webui/assets/js/core/store/index.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, feed });
  return feed as HTMLElement;
}

describe("фронтенд: жизненный цикл ленты", () => {
  it("closing a tab clears its busy timer", () => {
    const feed = mountTab("S1");
    core.showBusy(feed);
    const st = storeCore.streamStateFor(feed);
    expect(st.busyTimer).toBeTruthy();

    core.clearBusy(feed);

    expect(st.busyTimer).toBeFalsy();
    expect(feed.querySelector(".busy")).toBeNull();
  });

  it("busy stays on while another session is still running", () => {
    store.session.runningSessionIds = ["A", "B"];
    turn.onTurnEnd({ sessionId: "A" });
    expect(store.session.busy).toBe(true);

    store.session.runningSessionIds = [];
    turn.onTurnEnd({ sessionId: "B" });
    expect(store.session.busy).toBe(false);
  });

  it("the feed is trimmed to FEED_MAX_NODES", () => {
    const feed = mountTab("S2");
    for (let i = 0; i < core.FEED_MAX_NODES + 40; i++) {
      const node = win.document.createElement("div");
      node.className = "act";
      core.appendTo(feed, node);
    }
    expect(feed.childElementCount).toBeLessThanOrEqual(core.FEED_MAX_NODES);
  });

  it("thought header carries the applied reasoning level (INV-R9)", () => {
    const { wrap } = core.buildThinkBlock(true, undefined, { level: "high", source: "policy" });
    const lvl = wrap.querySelector(".think-h .lvl");
    expect(lvl?.textContent).toBe("high");
    expect((lvl as HTMLElement | null)?.title).toBe("policy");
  });

  it("thought header has no level marker when the decision is unknown", () => {
    const { wrap } = core.buildThinkBlock(true);
    expect(wrap.querySelector(".think-h .lvl")).toBeNull();
  });
});
