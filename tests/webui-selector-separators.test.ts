// The `/` separators must stay visible while capabilities are unknown: a
// hidden chip as an immediate sibling would hide the adjacent separator.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { setupHappyDom } from "./helpers/happy-dom";

const HTML = readFileSync(new URL("../src/modules/webui/assets/index.html", import.meta.url), "utf-8");
const selectors = HTML.match(/<div class="selectors">[\s\S]*?\n      <\/div>/)?.[0];
setupHappyDom(selectors);
const { syncSelectorSeparators } = await import("../src/modules/webui/assets/js/settings/selector-line.js");

describe("compact selector separators", () => {
  it("keeps every separator visible when caps are unknown", () => {
    const caps = document.getElementById("capsChip") as HTMLElement;
    const reasoning = document.querySelector<HTMLElement>('[data-sel="reasoning"]') as HTMLElement;
    caps.hidden = true;
    reasoning.hidden = false;

    syncSelectorSeparators(document);

    const seps = document.querySelectorAll<HTMLElement>(".selector-sep");
    expect(seps).toHaveLength(3);
    for (const sep of seps) expect(sep.hidden).toBe(false);
  });
});
