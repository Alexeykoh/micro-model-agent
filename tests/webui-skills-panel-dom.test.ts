// Фронтенд-гвард панели «Навыки»: встроенные скиллы отделены от внешних
// секциями и помечены бейджем (спека `2026-11-10-skills-panel-builtin-design.md`).
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs"></div><div data-panel="skills"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.settings.skills_section_builtin": "built-in",
    "web.settings.skills_section_external": "external",
    "web.settings.skills_builtin": "built-in",
    "web.settings.available": "available",
    "web.settings.enabled": "enabled",
  },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const panel = await import("../src/modules/webui/assets/js/settings/panels-skills.js");

function sections(): string[] {
  return [...win.document.querySelectorAll(".skill-section")].map((e) => e.textContent || "");
}
function items(): Element[] {
  return [...win.document.querySelectorAll(".skill-item")];
}

describe("фронтенд: группировка панели навыков", () => {
  it("встроенные и внешние — отдельные секции; у встроенного есть бейдж", () => {
    store.settings.skills = [
      { name: "alpha", kind: "builtin", enabled: false },
      { name: "beta", kind: "global", enabled: false },
      { name: "gamma", kind: "project", enabled: true },
    ];
    panel.renderSkillsPanel();
    expect(sections()).toEqual(["built-in", "external"]);
    const all = items();
    expect(all).toHaveLength(3);
    expect(all[0].querySelector(".name")?.textContent).toBe("alpha");
    expect(all[0].querySelector(".skill-badge")?.textContent).toBe("built-in");
    expect(all[1].querySelector(".skill-badge")).toBeNull();
  });

  it("без встроенных — только секция внешних, бейджей нет", () => {
    store.settings.skills = [{ name: "beta", kind: "global" }];
    panel.renderSkillsPanel();
    expect(sections()).toEqual(["external"]);
    expect(win.document.querySelector(".skill-badge")).toBeNull();
  });
});
