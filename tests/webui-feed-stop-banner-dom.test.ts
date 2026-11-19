// Guard: причина принудительной остановки хода (stalled/silent/duplicate) —
// внутренняя диагностика петли. В обычном режиме в ленте её быть не должно,
// только в «подробно».
//
// Регресс из стресс-теста (волна 21): после застревания в ленте появлялся
// жёлтый блок «⚠ Остановлено после серии пакетов с ошибкой — принудительный
// ответ из собранного.» (`web.turn.stop_stalled`).
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div><div id="live" aria-live="polite"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };

const store = await import("../src/modules/webui/assets/js/store.js");
const turn = await import("../src/modules/webui/assets/js/feed/turn.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, feed });
  return feed as HTMLElement;
}

describe("фронтенд: причина принудительной остановки хода", () => {
  it("в обычном режиме баннера остановки нет", () => {
    store.settings.config = { ui: { verbosity: "quiet" } };
    const feed = mountTab("stop-quiet");
    turn.onTurnEnd({ sessionId: "stop-quiet", success: true, stopReason: "stalled", toolCalls: 3 });

    expect(feed.querySelector(".warnline")).toBeNull();
    expect(feed.textContent || "").not.toContain("web.turn.stop_stalled");
  });

  it("в режиме «подробно» баннер виден", () => {
    store.settings.config = { ui: { verbosity: "verbose" } };
    const feed = mountTab("stop-verbose");
    turn.onTurnEnd({ sessionId: "stop-verbose", success: true, stopReason: "stalled", toolCalls: 3 });

    const warn = feed.querySelector(".warnline");
    expect(warn).toBeTruthy();
    expect(warn?.textContent || "").toContain("web.turn.stop_stalled");
  });
});
