// Theme picker grid: two labelled sections (color / seasonal) with a swatch
// and a one-line description per card. Extracted from `panels.ts` to keep the
// settings module under the file-size gate.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { UI_THEMES } from "./themes.js";

/** Builds the picker; `onPick` runs on click (the caller persists + applies). */
export function buildThemePicker(active: string, onPick: (id: string) => void): HTMLElement {
  const picker = el("div", "theme-picker");
  (["color", "seasonal"] as const).forEach((group) => {
    picker.appendChild(el("div", "theme-group-label", t("web.settings.theme.group." + group)));
    const grid = el("div", "theme-grid");
    UI_THEMES.filter((opt) => opt.group === group).forEach((opt) => {
      const card = el("button", "theme-card" + (opt.id === active ? " on" : ""));
      card.type = "button";
      card.setAttribute("aria-pressed", opt.id === active ? "true" : "false");
      card.title = t("web.settings.theme." + opt.id);
      const swatch = el("span", "theme-swatch");
      swatch.style.background = `linear-gradient(135deg, ${opt.colors.join(", ")})`;
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
