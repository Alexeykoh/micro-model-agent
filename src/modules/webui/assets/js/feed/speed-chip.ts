// Final generation-speed chip above the composer: exact per-turn tok/s from the
// `llmSpeed` snapshot, with a per-call breakdown in the tooltip.
import { attachTooltip, el } from "../dom.js";
import { t } from "../i18n.js";
import { fmtTokens } from "../format.js";
import { speedText } from "../speed.js";
import type { Dict } from "../core/store/types.js";

function speedTip(s: Dict): Node {
  const box = el("div", "speed-tip");
  box.appendChild(
    el(
      "div",
      "speed-tip-h",
      t("web.speed.total", {
        tokens: fmtTokens(Number(s.completionTokens) || 0),
        sec: ((Number(s.decodeMs) || 0) / 1000).toFixed(1),
      }),
    ),
  );
  const calls = Array.isArray(s.calls) ? s.calls : [];
  calls.forEach((c, i: number) => {
    if (!c || !(c.decodeMs > 0)) return;
    const rate = Math.round((Number(c.completionTokens) || 0) / (c.decodeMs / 1000));
    box.appendChild(
      el(
        "div",
        "speed-tip-row",
        t("web.speed.call", {
          n: i + 1,
          tokens: String(c.completionTokens),
          sec: (c.decodeMs / 1000).toFixed(1),
          rate,
        }),
      ),
    );
  });
  if (calls.some((c) => c && c.source === "estimate")) {
    box.appendChild(el("div", "speed-tip-note", t("web.speed.estimate_note")));
  }
  return box;
}

export function renderSpeed(h: Dict): void {
  const chip = document.getElementById("speedChip");
  if (!chip) return;
  const s = h.llmSpeed && typeof h.llmSpeed === "object" ? (h.llmSpeed as Dict) : null;
  const tokens = s && typeof s.completionTokens === "number" ? s.completionTokens : 0;
  const ms = s && typeof s.decodeMs === "number" ? s.decodeMs : 0;
  if (!s || !(tokens > 0) || !(ms > 0)) {
    chip.hidden = true;
    chip.textContent = "";
    chip.removeAttribute("title");
    return;
  }
  const calls = Array.isArray(s.calls) ? s.calls : [];
  const estimated = calls.some((c) => c && c.source === "estimate");
  chip.hidden = false;
  chip.textContent = speedText(tokens / (ms / 1000), estimated);
  chip.title = t("web.speed.title");
  attachTooltip(chip, () => speedTip(s));
}
