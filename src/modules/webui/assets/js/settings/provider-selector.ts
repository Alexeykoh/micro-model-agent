// Chat provider chip + menu. Kept out of `selectors-write.ts` so that file
// stays under the 300-line ceiling: this is the only selector with brand icons.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { closeAllMenus } from "../core/menus.js";
import { providerIcon } from "./provider-icons.js";
import { setCompactLabel } from "./selector-line.js";

export function renderProviderSelector(
  btn: HTMLElement | null,
  menu: HTMLElement | null,
  provider: Dict,
  select: (name: string) => void,
): void {
  if (!btn || !menu) return;
  const value = provider.active || provider.type || "—";
  const entries: Dict[] =
    Array.isArray(provider.entries) && provider.entries.length
      ? provider.entries
      : [{ label: value, type: provider.type }];
  const active = entries.find((e: Dict) => (e.label || e.type) === value);
  const label = t("web.selectors.provider");

  setCompactLabel(btn, label, value, providerIcon(active?.type, value));

  menu.textContent = "";
  entries.forEach((entry: Dict) => {
    const name = entry.label || entry.type;
    if (!name) return;
    const on = name === value;
    const item = el("button", "mi row-mi" + (on ? " on" : ""));
    item.type = "button";
    item.setAttribute("aria-pressed", on ? "true" : "false");
    item.appendChild(providerIcon(entry.type, name));
    item.appendChild(el("span", "", name));
    item.appendChild(el("span", "sub", entry.type || ""));
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeAllMenus();
      select(name);
    });
    menu.appendChild(item);
  });
}
