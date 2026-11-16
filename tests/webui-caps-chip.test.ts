// Composer capability chip: the pure mapping from resolved model capabilities
// to the labels shown next to the model selector, plus the DOM wiring.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { capabilityKeys } from "../src/modules/webui/assets/js/settings/caps-chip";

const HTML = readFileSync(
  new URL("../src/modules/webui/assets/index.html", import.meta.url),
  "utf-8",
);
const CSS = readFileSync(
  new URL("../src/modules/webui/assets/styles.css", import.meta.url),
  "utf-8",
);
const SELECTORS = readFileSync(
  new URL("../src/modules/webui/assets/js/settings/selectors-write.ts", import.meta.url),
  "utf-8",
);
const CAPS_RENDER = readFileSync(
  new URL("../src/modules/webui/assets/js/settings/caps-chip-render.ts", import.meta.url),
  "utf-8",
);

describe("model capabilities chip", () => {
  it("lists vision, tools and reasoning when all are supported", () => {
    expect(capabilityKeys({ vision: true, tools: true }, { strategy: "openai-effort" })).toEqual([
      "vision",
      "tools",
      "reasoning",
    ]);
  });

  it("omits unsupported abilities and text-only reasoning", () => {
    expect(capabilityKeys({ vision: false, tools: true }, { strategy: "none" })).toEqual(["tools"]);
    expect(capabilityKeys({ vision: false, tools: false }, { strategy: "none" })).toEqual([]);
  });

  it("stays empty while capabilities are unknown", () => {
    expect(capabilityKeys(null, { strategy: "openai-effort" })).toEqual([]);
    expect(capabilityKeys(undefined, undefined)).toEqual([]);
  });

  it("is wired into the composer row next to the model selector", () => {
    expect(HTML).toContain('id="capsChip"');
    expect(HTML.indexOf('data-sel="model"')).toBeLessThan(HTML.indexOf('id="capsChip"'));
    expect(HTML.indexOf('id="capsChip"')).toBeLessThan(HTML.indexOf('data-sel="context"'));
    expect(CSS).toContain(".caps-chip {");
    expect(SELECTORS).toContain("renderCapsChip()");
    expect(CAPS_RENDER).toContain('vision: "eye"');
    expect(CAPS_RENDER).toContain('tools: "wrench"');
    expect(CAPS_RENDER).toContain('reasoning: "brain"');
    expect(CAPS_RENDER).toContain("btn.title = label");
    expect(CAPS_RENDER).toContain("openSubDialog");
    expect(CAPS_RENDER).toContain("web.caps.popTitle");
  });
});
