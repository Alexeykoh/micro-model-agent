// Guard (B-10): объявление «ход завершён» не должно переживать старт нового
// хода — иначе screen-reader/живой регион показывает статус прошлого хода.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="live" role="status"></div>`);
const dom = await import("../src/modules/webui/assets/js/dom.js");

describe("live-объявление хода", () => {
  it("announce пишет текст, clearAnnounce сбрасывает", async () => {
    dom.announce("ход завершён");
    await new Promise((r) => setTimeout(r, 50));
    const live = win.document.querySelector("#live") as HTMLElement;
    expect(live.textContent).toBe("ход завершён");

    dom.clearAnnounce();
    expect(live.textContent).toBe("");
  });
});
