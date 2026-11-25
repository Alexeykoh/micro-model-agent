// tests/webui-compact-selector-line.test.ts
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

// dom.ts captures refs at import time, so a DOM must exist before importing.
setupHappyDom();
const line = await import("../src/modules/webui/assets/js/settings/selector-line.js");

describe("compact selector line", () => {
  it("keeps the model tail when shortening", () => {
    expect(line.tailLabel("[heretic/38ts] ornith-1.5-9b-uncensored", 30)).toBe(
      "…ornith-1.5-9b-uncensored",
    );
  });

  it("does not shorten a value that fits", () => {
    expect(line.tailLabel("auto", 8)).toBe("auto");
  });

  it("keeps full label and value for assistive tech", () => {
    setupHappyDom();
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    line.setCompactLabel(btn, "модель", "[heretic/38ts] ornith-1.5-9b-uncensored");
    expect(btn.title).toBe("модель: [heretic/38ts] ornith-1.5-9b-uncensored");
    expect(btn.getAttribute("aria-label")).toBe(btn.title);
    expect(btn.dataset.value).toBe("[heretic/38ts] ornith-1.5-9b-uncensored");
    expect(btn.querySelector("b > span")?.textContent).toBe(
      "[heretic/38ts] ornith-1.5-9b-uncensored",
    );
    expect(btn.querySelectorAll("svg.svg-icon")).toHaveLength(1);
  });

  it("hides a separator next to a hidden selector", () => {
    setupHappyDom(`<div class="selectors">
      <div class="sel" data-sel="context"></div>
      <span class="selector-sep">/</span>
      <div class="sel" data-sel="reasoning" hidden></div>
    </div>`);
    line.syncSelectorSeparators(document);
    expect(document.querySelector<HTMLElement>(".selector-sep")?.hidden).toBe(true);
  });
});
