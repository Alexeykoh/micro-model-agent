// Theme picker grid: labelled sections (color / seasonal / themed / OS) with
// a swatch and a one-line description per card. Extracted from `panels.ts` to
// keep the settings module under the file-size gate.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { UI_THEMES } from "./themes.js";
import { activeOmarchyTheme } from "./os-theme.js";

/**
 * Builds the picker; `onPick` runs on click (the caller persists + applies).
 * `osThemes` hides the OS section when the server is not on Linux.
 */
export function buildThemePicker(
  active: string,
  onPick: (id: string) => void,
  osThemes = false,
): HTMLElement {
  const picker = el("div", "theme-picker");
  (["color", "seasonal", "themed", "os"] as const).forEach((group) => {
    if (group === "os" && !osThemes) return;
    const themes = UI_THEMES.filter((opt) => opt.group === group);
    if (!themes.length) return;
    picker.appendChild(el("div", "theme-group-label", t("web.settings.theme.group." + group)));
    const grid = el("div", "theme-grid");
    themes.forEach((opt) => {
      const card = el("button", "theme-card theme-" + opt.id + (opt.id === active ? " on" : ""));
      card.type = "button";
      card.setAttribute("aria-pressed", opt.id === active ? "true" : "false");
      card.title = t("web.settings.theme." + opt.id);
      const swatch = el("span", "theme-swatch");
      const osTheme = opt.id === "omarchy" ? activeOmarchyTheme() : null;
      const dots = osTheme
        ? [
            osTheme.colors.background ?? osTheme.colors.color0 ?? opt.colors[0],
            osTheme.colors.accent ?? osTheme.colors.blue ?? opt.colors[1],
            osTheme.colors.magenta ?? osTheme.colors.color5 ?? opt.colors[2],
          ]
        : opt.colors;
      swatch.style.background = `linear-gradient(135deg, ${dots.join(", ")})`;
      card.appendChild(swatch);
      const text = el("span", "theme-card-body");
      text.appendChild(el("span", "theme-name", t("web.settings.theme." + opt.id)));
      const key = "web.settings.theme." + opt.id + ".desc";
      const desc = t(key);
      if (desc !== key) text.appendChild(el("span", "theme-card-desc", desc));
      card.appendChild(text);
      card.addEventListener("click", () => onPick(opt.id));
      grid.appendChild(card);
    });
    picker.appendChild(grid);
  });
  return picker;
}
