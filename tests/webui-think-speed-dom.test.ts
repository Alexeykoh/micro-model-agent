/**
 * Заголовок блока размышлений показывает ТОЛЬКО длительность: скорость tok/s
 * живёт в единственном месте — чипе в футере (без дублей в ленте и рельсе).
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
  } as never,
};
const store = await import("../src/modules/webui/assets/js/store.js");
const stream = await import("../src/modules/webui/assets/js/feed/stream.js");

function mountTab(id: string): HTMLElement {
  // Bun shares the module registry across test files: drop tabs left by an
  // earlier file, otherwise `feedForEvent` resolves the stale feed with this id.
  store.tabs.tabs.length = 0;
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, kind: "session", feed });
  return feed as HTMLElement;
}

describe("think block header", () => {
  it("thinkDurText shows seconds only", () => {
    const t0 = 1_000_000;
    expect(stream.thinkDurText(t0, t0 + 2000)).toBe("· 2.0s");
  });

  it("live header shows seconds but no tok/s while reasoning streams", async () => {
    const feed = mountTab("S1");
    const storeCore = await import("../src/modules/webui/assets/js/core/store/index.js");
    stream.onReasoning("x".repeat(400), "S1", { level: "low" });
    const st = storeCore.streamStateFor(feed);
    expect(st.curThink).not.toBeNull();
    st.curThink.startedAt = Date.now() - 2000;
    stream.finishThink(feed);
    const dur = feed.querySelector(".think-h .dur");
    expect(dur?.textContent).toContain("s");
    expect(dur?.textContent).not.toContain("tok/s");
  });
});
