// Removing a provider is destructive (config write + reconfigure), so the chip
// must ask first. Before this guard the click sent DELETE immediately.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

// No #saveIndicator on purpose: setIndicator() then no-ops instead of leaving
// its module-level queue/timer behind for other DOM tests in the same process.
const HTML = `
  <div data-panel="model"></div>
  <div class="overlay" id="confirmOverlay">
    <div class="modal modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle">
      <div class="modal-top"><span id="confirmTitle"></span></div>
      <div class="modal-body confirm-body">
        <p class="confirm-msg" id="confirmMsg"></p>
        <div class="confirm-actions">
          <button class="linkbtn confirm-cancel" id="confirmCancel" type="button">cancel</button>
          <button class="linkbtn danger confirm-accept" id="confirmAccept" type="button">delete</button>
        </div>
      </div>
    </div>
  </div>`;

setupHappyDom(HTML);
const g = globalThis as unknown as Record<string, unknown>;

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
const store = await import("../src/modules/webui/assets/js/store.js");
const { renderModelPanel } = await import(
  "../src/modules/webui/assets/js/settings/providers.js"
);

const originalFetch = g.fetch;
const originalLocale = i18n.I18N.locale;
const originalDicts = i18n.I18N.dicts;

let entries: Array<Record<string, unknown>> = [];
let deletes: string[] = [];

const mockFetch = async (url: string, init?: { method?: string }): Promise<Response> => {
  const u = String(url);
  if (u.startsWith("/api/providers/") && init?.method === "DELETE") {
    const name = decodeURIComponent(u.slice("/api/providers/".length));
    deletes.push(name);
    entries = entries.filter((e) => e.label !== name);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (u === "/api/providers" && (!init?.method || init.method === "GET")) {
    return new Response(JSON.stringify({ ok: true, active: "active-one", entries, presets: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
};

const overlay = (): HTMLElement => document.getElementById("confirmOverlay") as HTMLElement;
const deleteChip = (): HTMLButtonElement =>
  document.querySelector(".provider-item button.chip.danger") as HTMLButtonElement;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mount(): void {
  entries = [
    { label: "active-one", type: "lmstudio", baseUrl: "http://localhost:1234/v1", hasApiKey: false },
    { label: "other", type: "openai-compat", baseUrl: "http://localhost:1235/v1", hasApiKey: false },
  ];
  deletes = [];
  overlay().classList.remove("open");
  store.settings.config = { model: "m", provider: { active: "active-one", type: "lmstudio" } } as never;
  store.settings.registry = [];
  store.settings.models = [];
  store.settings.modelsStatus = "ready";
  store.settings.modelsReady = true;
  store.settings.providers = { active: "active-one", entries, presets: [] };
  renderModelPanel();
}

beforeEach(() => {
  g.fetch = mockFetch;
  i18n.I18N.locale = "en";
  i18n.I18N.dicts = {
    en: {
      "web.settings.provider_delete_confirm_title": "Delete provider?",
      "web.settings.provider_delete_confirm_body": "“{name}” will be removed from the config.",
      "web.settings.delete": "delete",
      "web.settings.cancel": "cancel",
      "web.action.cancel": "cancel",
    },
  };
  mount();
});

afterAll(() => {
  g.fetch = originalFetch;
  i18n.I18N.locale = originalLocale;
  i18n.I18N.dicts = originalDicts;
});

describe("provider delete confirmation", () => {
  it("opens the confirm dialog with the provider name and sends no DELETE yet", () => {
    expect(deleteChip()).toBeTruthy();
    deleteChip().click();
    expect(overlay().classList.contains("open")).toBe(true);
    expect(document.getElementById("confirmTitle")?.textContent).toBe("Delete provider?");
    expect(document.getElementById("confirmMsg")?.textContent).toContain("other");
    expect(deletes).toEqual([]);
  });

  it("cancel closes the dialog without deleting", () => {
    deleteChip().click();
    (document.getElementById("confirmCancel") as HTMLButtonElement).click();
    expect(overlay().classList.contains("open")).toBe(false);
    expect(deletes).toEqual([]);
  });

  it("accept sends DELETE only for the confirmed provider", async () => {
    deleteChip().click();
    (document.getElementById("confirmAccept") as HTMLButtonElement).click();
    await flush();
    expect(deletes).toEqual(["other"]);
    expect(overlay().classList.contains("open")).toBe(false);
  });

  it("keeps no delete chip on the active provider", () => {
    const active = [...document.querySelectorAll(".provider-item")].find(
      (n) => n.querySelector(".p-name")?.textContent === "active-one",
    );
    expect(active?.querySelector("button.chip.danger")).toBeNull();
  });
});
