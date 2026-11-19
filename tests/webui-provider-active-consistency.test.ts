// Один источник правды для «активного» провайдера: живой конфиг, а не
// снимок `/api/providers`. Иначе список в настройках и чип композера
// показывали разных провайдеров (живой баг 0.18.6).
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";
import type { AppConfig } from "../src/config/types";
import { DEFAULTS } from "../src/config/defaults";

function cfg(over: Partial<AppConfig["provider"]>): AppConfig {
  return {
    ...DEFAULTS,
    provider: { ...DEFAULTS.provider, ...over },
  } as AppConfig;
}

const provider = {
  type: "lmstudio",
  baseUrl: "http://localhost:1234/v1",
  active: "lmstudio",
  entries: [
    { type: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", label: "opencode-go" },
    { type: "lmstudio", baseUrl: "http://localhost:1234/v1", label: "lmstudio" },
  ],
};

describe("providers view: active resolves to a real entry", () => {
  it("keeps an active that matches an entry label", async () => {
    const { buildProviderViews } = await import("../src/modules/webui/settings/providers-view");
    const view = buildProviderViews(cfg(provider));
    expect(view.active).toBe("lmstudio");
  });

  it("falls back to the first entry when active is a stale legacy type", async () => {
    const { buildProviderViews } = await import("../src/modules/webui/settings/providers-view");
    const view = buildProviderViews(cfg({ ...provider, active: "openai-compat" }));
    expect(view.active).toBe("opencode-go");
  });

  it("uses the legacy type when there are no entries", async () => {
    const { buildProviderViews } = await import("../src/modules/webui/settings/providers-view");
    const view = buildProviderViews(cfg({ type: "lmstudio", active: undefined, entries: [] }));
    expect(view.active).toBe("lmstudio");
  });
});

describe("settings list: config wins over a stale providers snapshot", () => {
  it("marks the provider from the live config, not the old /api/providers active", async () => {
    setupHappyDom(`<div data-panel="model"></div>`);
    const store = await import("../src/modules/webui/assets/js/store.js");
    const i18n = await import("../src/modules/webui/assets/js/i18n.js");
    i18n.I18N.locale = "en";
    i18n.I18N.dicts = {
      en: Object.fromEntries(
        [
          "web.settings.active",
          "web.settings.provider_make_active",
          "web.settings.provider_edit",
          "web.settings.provider_delete",
          "web.settings.add_provider",
          "web.settings.providers",
          "web.settings.model",
          "web.settings.provider_active_guard",
          "web.settings.save_failed",
        ].map((k) => [k, k]),
      ),
    };
    // Снимок провайдеров устарел: активен opencode-go, а в конфиге — lmstudio.
    store.settings.providers = {
      active: "opencode-go",
      entries: [
        {
          label: "opencode-go",
          type: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
          hasApiKey: true,
        },
        {
          label: "lmstudio",
          type: "lmstudio",
          baseUrl: "http://localhost:1234/v1",
          hasApiKey: false,
        },
      ],
      presets: [],
    };
    store.settings.config = { provider: { active: "lmstudio" }, model: "x" } as never;
    const { renderModelPanel } =
      await import("../src/modules/webui/assets/js/settings/providers.js");
    renderModelPanel();
    const activeItems = [...document.querySelectorAll(".provider-item.active")].map((n) =>
      (n.textContent || "").trim(),
    );
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0]).toContain("lmstudio");
    expect(activeItems[0]).not.toContain("opencode-go");
  });
});
