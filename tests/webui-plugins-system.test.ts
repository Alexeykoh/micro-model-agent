// Guard: вкладка «Плагины» показывает только плагины. Системные хуки модулей
// (execution/lsp-check/session/indexer …) скрыты: это часть харнесса, а не
// пользовательские плагины; их тумблеров в UI быть не должно.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="body"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "ru";
i18n.I18N.dicts = {
  ru: {
    "web.plugins.summary": "включено {active} · выключено {off}",
    "web.plugins.core_hidden": "встроенных модулей харнесса: {count} — они не плагины и не отключаются",
    "web.plugins.empty": "Плагинов нет.",
    "web.plugins.badge_builtin": "builtin",
    "web.plugins.enable": "включить плагин",
    "web.plugins.disable": "выключить плагин",
    "web.plugins.no_description": "",
  },
};

const state = await import("../src/modules/webui/assets/js/sidebar/state.js");
const sidebar = await import("../src/modules/webui/assets/js/sidebar/plugins.js");

function row(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    enabled: true,
    builtin: true,
    system: false,
    draft: false,
    source: "builtin",
    provides: { tools: [], hooks: [] },
    permissions: [],
    warnings: [],
    ...extra,
  };
}

describe("вкладка «Плагины»: системные модули скрыты", () => {
  it("не рисует строку и тумблер для system, показывает пользовательские", () => {
    state.sb.plugins.bodyEl = win.document.querySelector("#body") as HTMLElement;
    state.sb.plugins.loaded = true;
    state.sb.plugins.unavailable = false;
    state.sb.plugins.failures = [];
    state.sb.plugins.records = [
      row("execution", { system: true }),
      row("session", { system: true }),
      row("notify"),
    ];

    sidebar.renderPlugins();

    const names = [...state.sb.plugins.bodyEl.querySelectorAll(".plg-name")].map((n) => n.textContent);
    expect(names).toEqual(["notify"]);
    expect(state.sb.plugins.bodyEl.querySelectorAll(".toggle").length).toBe(1);
    expect(state.sb.plugins.bodyEl.textContent).toContain("встроенных модулей харнесса: 2");
  });
});
