// DOM-проверка первого слайда: язык сверху, короткое знакомство без
// чек-листа, «Начать» вместо «Далее» и отсутствие «Назад».
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
    languages: [
      { value: "en", label: "English" },
      { value: "ru", label: "Русский" },
    ],
    providers: [],
    current: {
      provider: "openai-compat",
      apiBase: "http://localhost:1234/v1",
      model: "qwen/qwen3.5-9b",
      contextWindow: 32768,
    },
  };
  return {
    state,
    gate: document.createElement("div"),
    render: () => {},
  } as unknown as SetupContext;
}

describe("setup welcome", () => {
  it("renders language at the top and a short intro without the needs list", () => {
    const c = ctx(0);
    render(c);
    expect(c.gate.querySelector(".setup-welcome")).not.toBeNull();
    expect(c.gate.querySelector(".setup-lang")).not.toBeNull();
    expect(c.gate.querySelector(".setup-intro-needs")).toBeNull();
    expect(c.gate.querySelector(".setup-welcome-lead")?.textContent).toContain("MMA");
    expect(c.gate.textContent).toContain("Interface language");
  });

  it("starts with «Start» and has no active back button", () => {
    const c = ctx(0);
    render(c);
    const actions = c.gate.querySelector(".setup-actions");
    expect(actions?.querySelector(".primary")?.textContent).toBe("Start");
    const back = actions?.querySelector("button") as HTMLButtonElement | null;
    expect(back?.disabled).toBe(true);
  });

  it("splits the provider hint into readable lines on a later step", () => {
    const c = ctx(2);
    render(c);
    expect(c.gate.querySelectorAll(".setup-hint-line").length).toBeGreaterThanOrEqual(3);
    expect(c.gate.querySelector(".setup-actions .primary")).not.toBeNull();
  });

  it("follows the selected locale", () => {
    I18N.locale = "ru";
    try {
      const c = ctx(0);
      render(c);
      expect(c.gate.querySelector(".setup-welcome-lead")?.textContent).toContain("агент");
      expect(c.gate.querySelector(".setup-lang")?.textContent).toContain("Русский");
    } finally {
      I18N.locale = "en";
    }
  });

  it("marks the active group and shows progress inside it", () => {
    const c = ctx(2);
    render(c);
    expect(c.gate.querySelector('[aria-current="step"]')?.textContent).toContain("Provider");
    expect(c.gate.querySelector(".setup-progress")?.textContent).toContain("2 of 5");
  });
});
