// РЎРёСЃС‚РµРјРЅС‹Рµ РјРѕРґСѓР»Рё вЂ” С‡Р°СЃС‚СЊ С…Р°СЂРЅРµСЃСЃР°: Сѓ РЅРёС… РЅРµ РґРѕР»Р¶РЅРѕ Р±С‹С‚СЊ С‚СѓРјР±Р»РµСЂР°,
// РєРѕС‚РѕСЂС‹Р№ РЅРµР»СЊР·СЏ РЅР°Р¶Р°С‚СЊ (Р»РѕР¶РЅС‹Р№ affordance). РџРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєРёРµ вЂ” СЃ С‚СѓРјР±Р»РµСЂРѕРј.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div data-panel="plugins"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
const store = await import("../src/modules/webui/assets/js/store.js");
const panels = await import("../src/modules/webui/assets/js/settings/panels.js");

const DICT: Record<string, string> = {
  "web.settings.plugins_system_header": "system modules",
  "web.settings.plugins_system_note": "harness modules, always run",
  "web.settings.plugins_system_locked": "system module вЂ” always on",
  "web.settings.plugins_header": "plugins",
  "web.settings.plugins_empty": "no plugins",
  "web.settings.builtin": "built-in",
  "web.settings.plugins_unavailable": "unavailable",
};

beforeEach(() => {
  i18n.I18N.locale = "en";
  i18n.I18N.dicts = { en: DICT };
  store.settings.pluginsData = {
    plugins: [
      { name: "core.agent", system: true, enabled: true },
      { name: "demo-plugin", system: false, enabled: true, source: "./demo.ts" },
    ],
    mcp: [],
  } as never;
  const host = win.document.querySelector('[data-panel="plugins"]') as HTMLElement;
  host.textContent = "";
});

describe("settings: system modules are not switchable", () => {
  it("shows a static badge instead of a disabled toggle for harness modules", () => {
    panels.renderPluginsPanel();
    const rows = [...win.document.querySelectorAll(".list-line")];
    const systemRow = rows.find((r) => r.textContent?.includes("core.agent"));
    const userRow = rows.find((r) => r.textContent?.includes("demo-plugin"));
    expect(systemRow).toBeTruthy();
    expect(userRow).toBeTruthy();
    expect(systemRow!.querySelector(".toggle")).toBeNull();
    expect(systemRow!.textContent).toContain("system module вЂ” always on");
    // РџРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєРёР№ РїР»Р°РіРёРЅ РїРѕ-РїСЂРµР¶РЅРµРјСѓ СѓРїСЂР°РІР»СЏРµС‚СЃСЏ С‚СѓРјР±Р»РµСЂРѕРј.
    expect(userRow!.querySelector(".toggle")).toBeTruthy();
  });
});
