// Composer capability chip renderer: positive abilities of the active model.
// Kept out of `selectors-write.ts` (file-size rule 6); the pure mapping lives in
// `caps-chip.ts` so it can be tested without a DOM.
import { t } from "../i18n.js";
import { session } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { el, icon } from "../dom.js";
import { openSubDialog } from "../subdialog.js";
import { capabilityKeys, type CapabilityKey } from "./caps-chip.js";

/** Lucide glyph per ability; the label lives in the per-icon tooltip. */
const CAP_ICON: Record<CapabilityKey, string> = {
  vision: "eye",
  tools: "wrench",
  reasoning: "brain",
};

const CAP_ORDER: CapabilityKey[] = ["vision", "tools", "reasoning"];

/** Popup body: what each icon means and whether this model supports it. */
function buildCapsPopup(info: Dict | undefined, active: Set<CapabilityKey>): HTMLElement {
  const box = el("div", "caps-pop");
  const strategy = info?.strategy && info.strategy !== "none" ? String(info.strategy) : "";
  const levels =
    Array.isArray(info?.levels) && info.levels.length ? ` (${info.levels.join("/")})` : "";
  for (const key of CAP_ORDER) {
    const on = active.has(key);
    const row = el("div", "caps-row" + (on ? " on" : " off"));
    const glyph = el("span", "caps-row-ico");
    glyph.appendChild(icon(CAP_ICON[key]));
    const text = el("div", "caps-row-text");
    const head = el("div", "caps-row-head");
    head.appendChild(el("span", "caps-row-title", t("web.caps." + key)));
    head.appendChild(el("span", "caps-row-state", t(on ? "web.caps.on" : "web.caps.off")));
    text.appendChild(head);
    text.appendChild(el("div", "caps-row-desc", t("web.caps." + key + ".desc")));
    if (key === "reasoning" && on && strategy) {
      text.appendChild(el("div", "caps-row-meta", t("web.caps.reasoningDetail", { strategy, levels })));
    }
    row.appendChild(glyph);
    row.appendChild(text);
    box.appendChild(row);
  }
  return box;
}

/**
 * Hidden while capabilities are unknown or the endpoint is unreachable;
 * `text-only` is shown only after the probe actually answered. Each icon is a
 * button that opens a short explanation popup.
 */
export function renderCapsChip(): void {
  const chip = document.getElementById("capsChip");
  if (!chip) return;
  const info: Dict | undefined = session.reasoning;
  const caps = session.capabilities;
  if (!caps || info?.reachable === false) {
    chip.hidden = true;
    chip.textContent = "";
    chip.removeAttribute("title");
    return;
  }
  const keys = capabilityKeys(caps, info);
  chip.hidden = false;
  chip.textContent = "";
  const strategy = info?.strategy && info.strategy !== "none" ? String(info.strategy) : "";
  const levels =
    Array.isArray(info?.levels) && info.levels.length ? ` (${info.levels.join("/")})` : "";
  if (keys.length === 0) {
    chip.textContent = t("web.caps.textOnly");
    chip.title = t("web.caps.titleNone");
    return;
  }
  chip.removeAttribute("title");
  const active = new Set(keys);
  for (const key of keys) {
    const label =
      key === "reasoning"
        ? t("web.caps.reasoningDetail", { strategy, levels })
        : t("web.caps." + key);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cap-ico";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.appendChild(icon(CAP_ICON[key]));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSubDialog(t("web.caps.popTitle"), buildCapsPopup(info, active));
    });
    chip.appendChild(btn);
  }
}
