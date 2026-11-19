// DOM-проверки новых шагов визарда: 2.0, контекст «Авто», настройки агента,
// тема/звуки, пресеты безопасности и финальная проверка.
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
const { createSetupState, stepIndex } = await import("../src/modules/webui/assets/setup-state.js");
const { validate } = await import("../src/modules/webui/assets/setup-actions.js");
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
    workspace: "/home/user/project",
    current: {
      provider: "openai-compat",
      apiBase: "http://localhost:1234/v1",
      model: "qwen/qwen3.5-9b",
      contextWindow: 32768,
      criticEnabled: true,
      webSearchEnabled: true,
      ui: { theme: "console", themeMode: "auto" },
    },
  };
  return {
    state,
    gate: document.createElement("div"),
    render: () => {},
  } as unknown as SetupContext;
}

describe("provider choice (2.0)", () => {
  it("shows the defaults and both options", () => {
    const c = ctx(1);
    render(c);
    expect(c.gate.textContent).toContain("Provider and model");
    expect(c.gate.textContent).toContain("http://localhost:1234/v1");
    expect(c.gate.querySelectorAll(".setup-opts .setup-opt")).toHaveLength(2);
  });

  it("skip switches to defaults and jumps to the agent section", () => {
    const c = ctx(1);
    render(c);
    const opts = c.gate.querySelectorAll<HTMLButtonElement>(".setup-opts .setup-opt");
    opts[1].click();
    expect(c.state.answers.configureProvider).toBe(false);
    expect(c.state.step).toBe(stepIndex("agent"));
  });

  it("back from the agent section returns to 2.0 after a skip", () => {
    const c = ctx(1);
    render(c);
    c.gate.querySelectorAll<HTMLButtonElement>(".setup-opts .setup-opt")[1].click();
    render(c); // шаг 3.0 с кнопками
    const back = c.gate.querySelector<HTMLButtonElement>(".setup-actions button");
    back?.click();
    expect(c.state.step).toBe(stepIndex("provider-choice"));
  });
});

describe("provider key (2.2)", () => {
  it("requires a key for providers that cannot work without one", () => {
    const c = ctx(3);
    c.state.answers.provider = "opencode-go";
    c.state.display!.providers = [{ type: "opencode-go", label: "OpenCode Go", requiresKey: true }];
    render(c);
    expect(c.gate.querySelector(".setup-key-required")).not.toBeNull();
    expect(validate(c)).toBe("Enter an API key for this provider.");
    c.state.answers.apiKey = "sk-test";
    expect(validate(c)).toBeNull();
  });
});

describe("context auto (2.4)", () => {
  it("offers Auto/Manual and switches to manual", () => {
    const c = ctx(5);
    render(c);
    const opts = c.gate.querySelectorAll<HTMLButtonElement>(".setup-seg .setup-seg-opt");
    expect(opts).toHaveLength(2);
    expect(c.state.answers.contextAuto).toBe(true);
    opts[1].click();
    expect(c.state.answers.contextAuto).toBe(false);
  });
});

describe("agent settings (3.x)", () => {
  it("critic and web search render an on/off switch", () => {
    const critic = ctx(7);
    render(critic);
    const sw = critic.gate.querySelector<HTMLButtonElement>(".setup-toggle .toggle");
    expect(sw?.getAttribute("aria-checked")).toBe("true");
    sw?.click();
    expect(critic.state.answers.criticEnabled).toBe(false);

    const search = ctx(8);
    render(search);
    expect(search.gate.textContent).toContain("Enable web search");
    expect(search.gate.querySelector(".setup-toggle .toggle")).not.toBeNull();
  });

  it("appearance renders all themes, modes and sound controls", () => {
    const c = ctx(9);
    render(c);
    expect(c.gate.querySelectorAll(".setup-theme").length).toBeGreaterThanOrEqual(12);
    expect(c.gate.querySelectorAll(".setup-seg .setup-seg-opt")).toHaveLength(3);
    expect(c.gate.textContent).toContain("Notification sounds");
    expect(c.gate.querySelector(".volume-ctl")).not.toBeNull();
    expect(c.gate.querySelector(".volume-ctl input")?.getAttribute("readonly")).not.toBeNull();
    expect(c.gate.querySelector(".setup-range")).toBeNull();
  });

  it("security keeps the toggles, adds presets and drops the sounds row", () => {
    const c = ctx(10);
    render(c);
    expect(c.gate.querySelectorAll(".setup-presets .setup-seg-opt")).toHaveLength(3);
    expect(c.gate.textContent).not.toContain("Notification sounds");
  });
});

describe("review (4.0)", () => {
  it("shows the workspace and the smoke test button", () => {
    const c = ctx(11);
    render(c);
    expect(c.gate.querySelector(".setup-workspace")?.textContent).toContain("/home/user/project");
    expect(c.gate.querySelector(".setup-smoke button")?.textContent).toContain("Test and run");
    expect(c.gate.textContent).toContain("Critic");
    expect(c.gate.textContent).toContain("Web search");
  });
});
