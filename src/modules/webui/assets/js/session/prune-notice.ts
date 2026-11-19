// "Clean up your sessions" notice for the sessions dropdown (U14). The server
// already warns in its log once the directory crosses 1000; this puts the same
// hint where the user actually is - and names the command, not just a count.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PRUNE_NOTICE_AT } from "./pins.js";

/** Shows the hint only for a long, unfiltered list; hidden otherwise. */
export function renderPruneNotice(total: number, filtered: boolean): void {
  const box = document.getElementById("sessPrune");
  if (!box) return;
  const show = !filtered && total >= PRUNE_NOTICE_AT;
  box.hidden = !show;
  if (!show) return;
  box.textContent = "";
  box.appendChild(el("span", "", t("web.sessions.prune_hint", { n: String(total) })));
  box.appendChild(el("code", "sess-prune-cmd", "mma session prune --dry-run"));
}
