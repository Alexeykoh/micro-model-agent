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

  it("fits a long model label without losing its tail", () => {
    setupHappyDom(`<div class="selectors">
      <div class="sel" data-sel="model"><button></button></div>
    </div>`);
    const root = document.querySelector<HTMLElement>(".selectors") as HTMLElement;
    const btn = root.querySelector<HTMLElement>("button") as HTMLElement;
    const full = "[heretic/38ts] ornith-1.5-9b-uncensored";
    line.setCompactLabel(btn, "модель", full);
    const b = btn.querySelector<HTMLElement>("b") as HTMLElement;
    // Narrow enough to force truncation; tailLabel drops the whole author tag
    // first, so the recognisable model name still fits and is kept.
    Object.defineProperty(b, "clientWidth", { configurable: true, value: 175 });

    line.fitModelLabel(btn);
    const shown = b.querySelector("span")?.textContent ?? "";
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("ornith-1.5-9b-uncensored")).toBe(true);
    expect(shown.length).toBeLessThan(full.length);
    expect(btn.title).toContain(full);

    expect(() => line.installModelFit(root)).not.toThrow();
    expect(b.querySelector("span")?.textContent).toBe(shown);
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
