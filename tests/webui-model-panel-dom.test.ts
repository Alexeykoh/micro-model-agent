// The "Model & provider" panel must stay split into focused tabs: an active
// summary on top, then Providers / Models / Performance / Capabilities. The old
// layout mixed all four in one scroll.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div data-panel="model"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };
const store = await import("../src/modules/webui/assets/js/store.js");
const { renderModelPanel } = await import(
  "../src/modules/webui/assets/js/settings/providers.js"
);

function mount(): void {
  store.settings.config = {
    model: "deepseek-v4.1-flash",
    contextWindow: 65536,
    provider: { type: "lmstudio", active: "lmstudio" },
  } as never;
  store.settings.registry = [];
  store.settings.models = ["qwen3.5-9b", "deepseek-v4.1-flash"];
  store.settings.modelsStatus = "ready";
  store.settings.modelsReady = true;
  store.settings.providers = {
    active: "lmstudio",
    entries: [
      {
        label: "lmstudio",
        type: "lmstudio",
        baseUrl: "http://localhost:1234/v1",
        contextWindow: 32768,
        hasApiKey: false,
      },
    ],
    presets: [],
  };
  renderModelPanel();
}

describe("model & provider panel", () => {
  beforeEach(mount);

  it("shows an active summary above the tabs", () => {
    const active = document.querySelector(".model-active");
    expect(active).toBeTruthy();
    expect(active?.textContent).toContain("deepseek-v4.1-flash");
    expect(active?.textContent).toContain("lmstudio");
  });

  it("splits the panel into four tabs with only Providers visible first", () => {
    const tabs = [...document.querySelectorAll<HTMLElement>(".model-tab")];
    expect(tabs).toHaveLength(4);
    expect(tabs[0].classList.contains("on")).toBe(true);
    const panes = [...document.querySelectorAll<HTMLElement>(".model-pane")];
    expect(panes.map((p) => p.dataset.pane)).toEqual([
      "providers",
      "models",
      "performance",
      "capabilities",
    ]);
    expect(panes[0].hidden).toBe(false);
    expect(panes.slice(1).every((p) => p.hidden)).toBe(true);
  });

  it("keeps catalogs out of the performance/capabilities panes", () => {
    const byPane = (name: string) =>
      document.querySelector<HTMLElement>(`.model-pane[data-pane="${name}"]`);
    expect(byPane("providers")?.querySelector(".provider-list")).toBeTruthy();
    expect(byPane("models")?.querySelector(".model-list")).toBeTruthy();
    expect(byPane("performance")?.querySelector(".provider-list, .model-list")).toBeNull();
    expect(byPane("capabilities")?.querySelector(".provider-list, .model-list")).toBeNull();
  });

  it("switches panes without re-rendering the whole panel", () => {
    const tabs = [...document.querySelectorAll<HTMLElement>(".model-tab")];
    tabs[2].click();
    const panes = [...document.querySelectorAll<HTMLElement>(".model-pane")];
    expect(panes[2].hidden).toBe(false);
    expect(panes[0].hidden).toBe(true);
    expect(tabs[2].classList.contains("on")).toBe(true);
  });

  it("pins the active model to the top of the Models tab", () => {
    const list = document.querySelector<HTMLElement>('.model-pane[data-pane="models"] .model-list');
    const first = list?.querySelector<HTMLElement>(".model-item .m-name");
    expect(first?.textContent).toBe("deepseek-v4.1-flash");
  });
});

describe("models tab: honest loading/error/empty states", () => {
  const listText = () =>
    document.querySelector<HTMLElement>('.model-pane[data-pane="models"] .model-list')
      ?.textContent || "";

  it("names the provider whose list is shown", () => {
    i18n.I18N.dicts = { en: { "web.settings.models_of_provider": "models of {provider}" } };
    try {
      mount();
      const pane = document.querySelector<HTMLElement>('.model-pane[data-pane="models"]');
      expect(pane?.textContent).toContain("models of lmstudio");
    } finally {
      i18n.I18N.dicts = { en: {} };
    }
  });

  it("says the list is loading instead of 'no models'", () => {
    mount();
    store.settings.models = [];
    store.settings.modelsStatus = "loading";
    store.settings.modelsReady = false;
    renderModelPanel();
    expect(listText()).toContain("web.settings.models_loading");
  });

  it("distinguishes a provider failure from an empty list", () => {
    mount();
    store.settings.models = [];
    store.settings.modelsStatus = "error";
    store.settings.modelsReady = true;
    renderModelPanel();
    expect(listText()).toContain("web.settings.models_error");
  });

  it("says the provider reported no models only after a successful reply", () => {
    mount();
    store.settings.models = [];
    store.settings.modelsStatus = "ready";
    store.settings.modelsReady = true;
    renderModelPanel();
    expect(listText()).toContain("web.settings.no_models");
  });

  it("flags a model that is not in the provider's list", () => {
    mount();
    store.settings.models = ["another-model"];
    store.settings.modelsStatus = "ready";
    renderModelPanel();
    const card = document.querySelector<HTMLElement>(".model-active");
    expect(card?.textContent).toContain("web.settings.model_not_in_provider");
  });
});

describe("active model card: an unconfirmed model is marked as such", () => {
  const cardText = () => document.querySelector<HTMLElement>(".model-active")?.textContent || "";

  it("marks the model as unchecked while the list is loading", () => {
    mount();
    store.settings.modelsStatus = "loading";
    store.settings.modelsReady = false;
    renderModelPanel();
    expect(cardText()).toContain("web.settings.model_checking");
    expect(cardText()).not.toContain("web.settings.model_not_in_provider");
  });

  it("marks the model as unverified when the provider did not answer", () => {
    mount();
    store.settings.modelsStatus = "error";
    store.settings.modelsReady = true;
    renderModelPanel();
    expect(cardText()).toContain("web.settings.model_unverified");
    expect(cardText()).not.toContain("web.settings.model_not_in_provider");
  });

  it("adds no caveat once the list confirms the model", () => {
    mount();
    expect(cardText()).not.toContain("web.settings.model_checking");
    expect(cardText()).not.toContain("web.settings.model_unverified");
    expect(cardText()).not.toContain("web.settings.model_not_in_provider");
  });
});
