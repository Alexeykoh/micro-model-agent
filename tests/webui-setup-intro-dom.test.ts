// DOM-проверка знакомства на первом шаге визарда: блок есть только на языке,
// содержит чек-лист из четырёх пунктов и локализуется вместе с остальным UI.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;

const { I18N } = await import("../src/modules/webui/assets/setup-i18n.js");
const { render } = await import("../src/modules/webui/assets/setup-render.js");
const { createSetupState } = await import("../src/modules/webui/assets/setup-state.js");
import type { SetupContext } from "../src/modules/webui/assets/setup-context.js";

function dict(name: string): Record<string, string> {
  return JSON.parse(readFileSync(join(process.cwd(), "src", "i18n", name), "utf8"));
}

I18N.dicts = { en: dict("en.json"), ru: dict("ru.json") };
I18N.locale = "en";

function ctx(step: number): SetupContext {
  const state = createSetupState();
  state.step = step;
  state.display = {
    languages: [{ value: "en", label: "English" }],
    providers: [],
  };
  return {
    state,
    gate: document.createElement("div"),
    render: () => {},
  } as unknown as SetupContext;
}

describe("setup intro", () => {
  it("renders the agent intro and four needs on the language step", () => {
    const c = ctx(0);
    render(c);
    const intro = c.gate.querySelector(".setup-intro");
    expect(intro).not.toBeNull();
    expect(intro?.textContent).toContain("You will need");
    expect(intro?.textContent).toContain("Provider URL");
    expect(c.gate.querySelectorAll(".setup-intro-needs .need")).toHaveLength(4);
    expect(c.gate.querySelector(".setup-intro-foot")?.textContent).toContain("local config");
  });

  it("does not render the intro on later steps", () => {
    const c = ctx(1);
    render(c);
    expect(c.gate.querySelector(".setup-intro")).toBeNull();
  });

  it("splits long hints into readable lines and keeps the footer buttons", () => {
    const c = ctx(1);
    render(c);
    expect(c.gate.querySelectorAll(".setup-hint-line").length).toBeGreaterThanOrEqual(3);
    expect(c.gate.querySelector(".setup-actions .primary")).not.toBeNull();
  });

  it("follows the selected locale", () => {
    I18N.locale = "ru";
    try {
      const c = ctx(0);
      render(c);
      expect(c.gate.querySelector(".setup-intro")?.textContent).toContain("Понадобится");
    } finally {
      I18N.locale = "en";
    }
  });
});
