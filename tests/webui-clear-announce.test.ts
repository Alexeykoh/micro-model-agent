// Guard (B-10): объявление «ход завершён» не должно переживать старт нового
// хода — иначе screen-reader/живой регион показывает статус прошлого хода.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="live" role="status"></div>`);
const dom = await import("../src/modules/webui/assets/js/dom.js");

describe("live-объявление хода", () => {
  it("announce пишет текст, clearAnnounce сбрасывает", async () => {
    dom.announce("ход завершён");
    // `announce` ставит текст через 30 мс. Ждём появления строки, а не
    // фиксированной паузы: под нагрузкой (полный прогон) таймер опаздывал,
    // и тест падал без причины.
    const live = win.document.querySelector("#live") as HTMLElement;
    for (let i = 0; i < 100 && live.textContent !== "ход завершён"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(live.textContent).toBe("ход завершён");

    dom.clearAnnounce();
    expect(live.textContent).toBe("");
  });
});
