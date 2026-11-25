// Behavioral test for the `?` hint toggle. The DOM must exist before the
// dynamic import because `dom.ts` captures refs at import time.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div class="inp-meta"><button id="hintMore" type="button" title="?" aria-label="?" aria-expanded="false">?</button></div>`);
const { initHintToggle } = await import("../src/modules/webui/assets/js/session/hint-toggle.js");

describe("hint toggle", () => {
  it("reveals and re-hides the compressed hints", () => {
    const btn = document.getElementById("hintMore") as HTMLElement;
    const meta = document.querySelector<HTMLElement>(".inp-meta") as HTMLElement;
    initHintToggle();

    btn.click();
    expect(meta.classList.contains("expanded")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");

    btn.click();
    expect(meta.classList.contains("expanded")).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
});
