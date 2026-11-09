/**
 * Заголовок блока размышлений показывает длительность + оценку т/с
 * во время стрима и на завершении (раньше .dur заполнялся только по
 * finishThink и только секундами, без т/с).
 */
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.action.thinking": "thinking",
    "web.action.show": "show",
    "web.action.hide": "hide" as never,
    "web.speed.tps": "{n} tok/s",
    "web.speed.estimated": "≈ {n} tok/s",
  } as never,
};
const store = await import("../src/modules/webui/assets/js/store.js");
const stream = await import("../src/modules/webui/assets/js/feed/stream.js");
const speed = await import("../src/modules/webui/assets/js/speed.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, feed });
  return feed as HTMLElement;
}

describe("think block tok/s", () => {
  it("thinkRate is null without chars/elapsed and positive after", () => {
    expect(speed.thinkRate(0, 1000)).toBeNull();
    expect(speed.thinkRate(40, 0)).toBeNull();
    // 400 chars = 100 tokens over 2s = 50 tok/s.
    expect(speed.thinkRate(400, 2000)).toBe(50);
  });

  it("thinkDurText includes tok/s when computable", () => {
    const t0 = 1_000_000;
    expect(stream.thinkDurText(400, t0, t0 + 2000)).toBe("· 2.0s · ≈ 50 tok/s");
    expect(stream.thinkDurText(0, t0, t0 + 2000)).toBe("· 2.0s");
  });

  it("live header shows seconds and tok/s while reasoning streams", async () => {
    const feed = mountTab("S1");
    const storeCore = await import("../src/modules/webui/assets/js/core/store/index.js");
    stream.onReasoning("x".repeat(400), "S1", { level: "low" });
    const st = storeCore.streamStateFor(feed);
    expect(st.curThink).not.toBeNull();
    // Подкрутить старт назад, чтобы скорость была детерминированной на финале.
    st.curThink.startedAt = Date.now() - 2000;
    stream.finishThink(feed);
    const dur = feed.querySelector(".think-h .dur");
    expect(dur?.textContent).toContain("tok/s");
    expect(dur?.textContent).toContain("s");
  });
});
