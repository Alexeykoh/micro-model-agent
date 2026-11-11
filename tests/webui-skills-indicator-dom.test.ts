// Фронтенд-гвард индикатора загруженных скиллов в композере:
// скрыт при 0 скиллов, виден с бейджем и тултипом при ≥1.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const HTML = `<button class="skills-btn" id="skillsBtn" type="button" hidden aria-label="Loaded skills"></button>`;

const win = setupHappyDom(HTML);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.composer.skills_title": "Loaded skills",
    "web.composer.skills_aria": "Loaded skills: {count}",
    "web.composer.skills_note": "takes effect next turn",
    "web.composer.skill_kind_builtin": "built-in",
    "web.composer.skill_kind_global": "global",
    "web.composer.skill_kind_project": "project",
  },
};

const indicator = await import("../src/modules/webui/assets/js/session/skills-indicator.js");

function host(): HTMLButtonElement { return win.document.getElementById("skillsBtn") as HTMLButtonElement; }
function badge(): HTMLElement { return host().querySelector(".skills-badge") as HTMLElement; }

beforeEach(() => {
  indicator.applySkillsEvent({ skills: [] });
});

describe("skills indicator", () => {
  it("hidden when no skills loaded", () => {
    indicator.applySkillsEvent({ skills: [] });
    expect(host().hidden).toBe(true);
  });

  it("visible with count badge when skills loaded", () => {
    indicator.applySkillsEvent({ skills: [{ name: "git", kind: "builtin" }, { name: "proj", kind: "project" }] });
    expect(host().hidden).toBe(false);
    expect(badge().textContent).toBe("2");
  });

  it("tooltip content lists names and source kinds", () => {
    indicator.applySkillsEvent({ skills: [{ name: "git", kind: "builtin" }, { name: "proj", kind: "project" }] });
    // attachTooltip builds content on hover; trigger mouseenter
    host().dispatchEvent(new win.Event("mouseenter"));
    const tip = win.document.querySelector(".ctip") as HTMLElement;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain("git");
    expect(tip.textContent).toContain("proj");
    expect(tip.textContent).toContain("built-in");
    expect(tip.textContent).toContain("project");
  });

  it("empty list hides the indicator", () => {
    indicator.applySkillsEvent({ skills: [{ name: "git", kind: "builtin" }] });
    expect(host().hidden).toBe(false);
    indicator.applySkillsEvent({ skills: [] });
    expect(host().hidden).toBe(true);
  });
});