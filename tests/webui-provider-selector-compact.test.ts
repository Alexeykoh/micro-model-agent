// The compact composer keeps the real provider brand mark and the full
// "label: value" in title/aria-label. DOM-level contract for that button.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

// dom.ts captures element refs at import time, so the DOM must exist first.
setupHappyDom(`<button id="selProviderBtn"></button><div id="selProviderMenu"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };
const { renderProviderSelector } = await import(
  "../src/modules/webui/assets/js/settings/provider-selector.js"
);

const PROVIDER = {
  active: "llama.cpp",
  entries: [
    { type: "llamacpp", label: "llama.cpp" },
    { type: "opencode-go", label: "opencode-go" },
  ],
};

describe("compact provider selector", () => {
  it("keeps the brand icon, accessible name and menu callback", () => {
    const btn = document.getElementById("selProviderBtn") as HTMLElement;
    const menu = document.getElementById("selProviderMenu") as HTMLElement;
    let chosen = "";
    renderProviderSelector(btn, menu, PROVIDER as never, (name) => {
      chosen = name;
    });

    // Empty i18n dict → the key is the literal label ("web.selectors.provider").
    const label = i18n.t("web.selectors.provider");
    expect(btn.title).toBe(`${label}: llama.cpp`);
    expect(btn.title).toContain("provider: llama.cpp");
    expect(btn.getAttribute("aria-label")).toBe(btn.title);
    expect(btn.querySelector(".provider-icon-llama")).toBeTruthy();
    expect(btn.textContent).toContain("llama.cpp");

    // One brand SVG plus exactly one chevron, and the chevron is last.
    const svgs = btn.querySelectorAll("svg.svg-icon");
    expect(svgs).toHaveLength(2);
    expect(svgs[0].classList.contains("provider-icon-llama")).toBe(true);
    expect(svgs[1].getAttribute("class")).toBe("svg-icon");
    expect(btn.lastElementChild).toBe(svgs[1]);

    const items = menu.querySelectorAll<HTMLElement>(".mi");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".provider-icon-llama")).toBeTruthy();
    expect(items[1].querySelector(".provider-icon-opencode-go")).toBeTruthy();
    items[1].click();
    expect(chosen).toBe("opencode-go");
  });
});
