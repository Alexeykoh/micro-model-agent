// Composer capability chip renderer: positive abilities of the active model.
// Kept out of `selectors-write.ts` (file-size rule 6); the pure mapping lives in
// `caps-chip.ts` so it can be tested without a DOM.
import { t } from "../i18n.js";
import { session } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { icon } from "../dom.js";
import { capabilityKeys, type CapabilityKey } from "./caps-chip.js";

/** Lucide glyph per ability; the label lives in the per-icon tooltip. */
const CAP_ICON: Record<CapabilityKey, string> = {
  vision: "eye",
  tools: "wrench",
  reasoning: "brain",
};

/**
 * Hidden while capabilities are unknown or the endpoint is unreachable;
 * `text-only` is shown only after the probe actually answered.
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
  for (const key of keys) {
    const label =
      key === "reasoning"
        ? t("web.caps.reasoningDetail", { strategy, levels })
        : t("web.caps." + key);
    const slot = document.createElement("span");
    slot.className = "cap-ico";
    slot.title = label;
    slot.setAttribute("role", "img");
    slot.setAttribute("aria-label", label);
    slot.appendChild(icon(CAP_ICON[key]));
    chip.appendChild(slot);
  }
}
