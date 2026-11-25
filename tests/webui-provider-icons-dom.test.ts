// Provider icons must be visible in both places the user picks a provider:
// the add/edit type dropdown and the settings provider list.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div data-panel="model"></div><button id="selProviderBtn"></button><div id="selProviderMenu"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };
const store = await import("../src/modules/webui/assets/js/store.js");
const { providerIcon, providerIconKey } = await import(
  "../src/modules/webui/assets/js/settings/provider-icons.js"
);
const { providerTypeField } = await import(
  "../src/modules/webui/assets/js/settings/provider-type-field.js"
);
const { renderProviderSelector } = await import(
  "../src/modules/webui/assets/js/settings/provider-selector.js"
);
const { renderModelPanel } = await import(
  "../src/modules/webui/assets/js/settings/providers.js"
);

const TYPES = [
  "openai-compat",
  "lmstudio",
  "llamacpp",
  "openrouter",
  "openai",
  "anthropic",
  "opencode-zen",
  "opencode-go",
];

describe("provider icon mapping", () => {
  it("maps every builtin type to a distinct brand (except the generic one)", () => {
    expect(TYPES.map((t) => providerIconKey(t))).toEqual([
      "generic",
      "lmstudio",
      "llama",
      "openrouter",
      "openai",
      "anthropic",
      "opencode",
      "opencode-go",
    ]);
  });

  it("recognizes well-known backends in custom entry labels", () => {
    expect(providerIconKey("openai-compat", "llama.cpp")).toBe("llama");
    expect(providerIconKey("openai-compat", "Ollama")).toBe("ollama");
    expect(providerIconKey("custom-type", "my-provider")).toBe("generic");
  });

  it("paints brand glyphs with currentColor so they read on the dark surface", () => {
    const svg = providerIcon("opencode-go");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.classList.contains("provider-icon-opencode-go")).toBe(true);
    expect(svg.querySelector("path")?.getAttribute("d")).toBeTruthy();
  });

  it("uses the official llama.cpp mark, not an infinity-like generic glyph", () => {
    const svg = providerIcon("openai-compat", "llama.cpp");
    expect(svg.getAttribute("viewBox")).toBe("0 0 600 600");
    expect(svg.querySelectorAll("path")).toHaveLength(2);
  });
});

describe("provider type dropdown", () => {
  it("renders an icon on every option and on the selected value", () => {
    const field = providerTypeField(TYPES, "opencode-go");
    const options = field.node.querySelectorAll<HTMLElement>(".ptype-opt");
    expect(options).toHaveLength(TYPES.length + 1); // leading "—"
    expect([...options].every((o) => o.querySelector("svg") !== null)).toBe(true);
    expect(field.node.querySelector(".ptype-btn .provider-icon-opencode-go")).toBeTruthy();
  });

  it("keeps an unknown stored type selectable", () => {
    const field = providerTypeField(TYPES, "legacy-provider");
    const values = [...field.node.querySelectorAll<HTMLElement>(".ptype-opt")].map(
      (o) => o.dataset.value,
    );
    expect(values).toContain("legacy-provider");
  });

  it("updates value and notifies the preset wiring on selection", () => {
    const field = providerTypeField(TYPES, "lmstudio");
    let changes = 0;
    field.addEventListener("change", () => changes++);
    const option = [...field.node.querySelectorAll<HTMLElement>(".ptype-opt")].find(
      (o) => o.dataset.value === "anthropic",
    );
    option?.click();
    expect(field.value).toBe("anthropic");
    expect(changes).toBe(1);
    expect(option?.getAttribute("aria-selected")).toBe("true");
    expect(field.node.querySelector<HTMLElement>(".ptype-menu")?.hidden).toBe(true);
  });

  it("opens with ArrowDown and closes with Escape", () => {
    const field = providerTypeField(TYPES, "openai");
    const btn = field.node.querySelector<HTMLElement>(".ptype-btn");
    const menu = field.node.querySelector<HTMLElement>(".ptype-menu");
    btn?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(menu?.hidden).toBe(false);
    expect(btn?.getAttribute("aria-expanded")).toBe("true");
    const first = field.node.querySelector<HTMLElement>(".ptype-opt");
    first?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu?.hidden).toBe(true);
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("chat provider selector", () => {
  it("shows the brand icon on the chip and every menu row", () => {
    const btn = document.getElementById("selProviderBtn") as HTMLElement;
    const menu = document.getElementById("selProviderMenu") as HTMLElement;
    let chosen = "";
    renderProviderSelector(
      btn,
      menu,
      {
        active: "llama.cpp",
        entries: [
          { type: "llamacpp", label: "llama.cpp" },
          { type: "opencode-go", label: "opencode-go" },
        ],
      } as never,
      (name) => {
        chosen = name;
      },
    );
    expect(btn.querySelector(".provider-icon-llama")).toBeTruthy();
    expect(btn.textContent).toContain("llama.cpp");
    const items = menu.querySelectorAll<HTMLElement>(".mi");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".provider-icon-llama")).toBeTruthy();
    expect(items[1].querySelector(".provider-icon-opencode-go")).toBeTruthy();
    items[1].click();
    expect(chosen).toBe("opencode-go");
  });
});

describe("settings provider list", () => {
  it("shows a brand icon next to each entry", () => {
    store.settings.config = { model: "qwen3.5-9b", provider: { active: "llama.cpp", type: "openai-compat" } } as never;
    store.settings.registry = [];
    store.settings.models = ["qwen3.5-9b"];
    store.settings.modelsStatus = "ready";
    store.settings.providers = {
      active: "llama.cpp",
      entries: [
        { label: "llama.cpp", type: "openai-compat", baseUrl: "http://localhost:8080/v1" },
        { label: "opencode-go", type: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" },
      ],
      presets: [],
    } as never;
    renderModelPanel();
    const items = document.querySelectorAll<HTMLElement>(".provider-item");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".p-head > .provider-icon-llama")).toBeTruthy();
    expect(items[1].querySelector(".p-head > .provider-icon-opencode-go")).toBeTruthy();
    expect(items[0].querySelector(".p-name")?.textContent).toBe("llama.cpp");
  });
});
