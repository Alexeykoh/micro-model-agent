import { describe, it, expect, afterEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`
  <div data-panel="model"></div>
  <div id="subOverlay" class="">
    <div id="subHost"></div>
    <span id="subTitle"></span>
    <button id="closeSub"></button>
  </div>
`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    ...(i18n.I18N.dicts?.en ?? {}),
    "web.settings.save": "save",
    "web.settings.cancel": "cancel",
    "config.enum.none": "—",
    "web.settings.model_capabilities.reset": "reset override",
    "web.settings.model_capabilities.detected": "Detected by provider: {values}",
    "web.settings.model_capabilities.note": "These values force-override model and provider settings.",
    "web.settings.model_capabilities.levels.none": "not set",
    "web.settings.model_capabilities.edit": "edit capabilities",
    "config.field.vision": "vision",
    "config.field.video": "video",
    "config.field.audio": "audio",
    "config.field.pdf": "pdf",
    "config.field.tools": "tools",
    "config.field.reasoningStrategy": "reasoningStrategy",
    "config.field.reasoningOff": "reasoningOff",
    "config.field.reasoningLevels": "reasoningLevels",
  },
};
const store = await import("../src/modules/webui/assets/js/store.js");
const { renderModelPanel } = await import(
  "../src/modules/webui/assets/js/settings/providers.js"
);
const form = await import(
  "../src/modules/webui/assets/js/settings/model-capabilities-form.js"
);

function mount(): void {
  store.settings.config = {
    model: "active-model",
    modelCapabilities: { "active-model": { vision: true } },
    provider: { type: "openai-compat", active: "llama.cpp" },
  } as never;
  store.settings.models = ["active-model", "bonsai-2-27b-pq2"];
  store.settings.modelsStatus = "ready";
  store.settings.modelsReady = true;
  store.settings.registry = [];
  store.settings.providers = {
    active: "llama.cpp",
    entries: [{ label: "llama.cpp", type: "openai-compat", baseUrl: "http://localhost:8080/v1" }],
    presets: [],
  };
  store.session.capabilities = null;
  store.session.reasoning = undefined;
  renderModelPanel();
}

const tick = (): Promise<void> => new Promise((r) => win.setTimeout(r, 10));

describe("per-model capabilities dialog", () => {
  afterEach(() => {
    store.session.capabilities = null;
    store.session.reasoning = undefined;
  });

  it("opens from the model row with the stored value prefilled", () => {
    mount();
    const row = [...document.querySelectorAll<HTMLElement>(".model-item")].find(
      (n) => n.querySelector(".m-name")?.textContent === "bonsai-2-27b-pq2",
    );
    const button = row?.querySelector<HTMLElement>("[data-cap-edit]");
    expect(button).toBeTruthy();
    button?.click();
    expect(document.getElementById("subOverlay")?.classList.contains("open")).toBe(true);
    const strategy = document.querySelector<HTMLSelectElement>(
      '#subHost select[aria-label="bonsai-2-27b-pq2: reasoningStrategy"]',
    );
    expect(strategy).toBeTruthy();
    expect(strategy?.value).toBe("");
    expect(document.querySelector("#subHost .caps-levels-btn")).toBeTruthy();
    expect(document.querySelector("#subHost .caps-note")?.textContent).toContain("force-override");
    expect(document.querySelectorAll('#subHost [aria-label$="reasoningOff"]').length).toBe(1);
  });

  it("posts the merged whole-key record and closes only on success", async () => {
    const calls: Array<{ key: string; value: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      // Only intercept our own write; other tests own their fetch stubs.
      if (!String(url).endsWith("/api/config")) return original(url, init);
      calls.push(JSON.parse(String(init?.body ?? "{}")) as { key: string; value: unknown });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      mount();
      form.openModelCapabilitiesDialog("bonsai-2-27b-pq2");
      const levelsBtn = document.querySelector<HTMLElement>(
        '#subHost button[aria-label="bonsai-2-27b-pq2: reasoningLevels"]',
      );
      if (!levelsBtn) throw new Error("levels button missing");
      levelsBtn.click();
      for (const level of ["low", "xhigh"]) {
        const box = [...document.querySelectorAll<HTMLInputElement>("#subHost .caps-levels-pop input")]
          .find((b) => b.value === level);
        if (!box) throw new Error(`level ${level} missing`);
        box.checked = true;
        box.dispatchEvent(new win.Event("change"));
      }
      const save = [...document.querySelectorAll<HTMLElement>("#subHost button")]
        .find((b) => b.textContent === "save");
      if (!save) throw new Error("save button missing");
      save.click();
      await tick();
      expect(calls).toHaveLength(1);
      expect(calls[0].key).toBe("modelCapabilities");
      expect(calls[0].value).toEqual({
        "active-model": { vision: true },
        "bonsai-2-27b-pq2": { reasoningLevels: ["low", "xhigh"] },
      });
      expect(document.getElementById("subOverlay")?.classList.contains("open")).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("shows the discovered hint only for the active model", () => {
    mount();
    store.session.capabilities = { vision: true };
    store.session.reasoning = { strategy: "openai-effort", levels: ["low"] };
    form.openModelCapabilitiesDialog("active-model");
    expect(document.getElementById("subHost")?.textContent).toContain(
      "Detected by provider:",
    );
    form.openModelCapabilitiesDialog("bonsai-2-27b-pq2");
    expect(document.getElementById("subHost")?.textContent).not.toContain(
      "Detected by provider:",
    );
  });
});
