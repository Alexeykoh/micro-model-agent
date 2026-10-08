// Button chrome for the Files tab: localized icons/titles and enable/disable
// state for the tree, history and viewer controls, plus the "expand hit its
// budget" note. Pure DOM sync over shared state — nothing here decides *what*
// the state is, only how the controls reflect it.
import { el, icon } from "../../dom.js";
import { t } from "../../i18n.js";
import { sb } from "../state.js";
import { canBack, canForward, type ViewerHistory } from "./history.js";
import { viewerFull } from "./split.js";
import { EXPAND_DIR_CAP } from "./constants.js";

/** Fills a button with an icon and a localized title/aria-label. */
export function iconize(btn: HTMLElement | null, name: string, key: string): void {
  if (!btn) return;
  btn.textContent = "";
  btn.appendChild(icon(name));
  btn.title = t(key);
  btn.setAttribute("aria-label", t(key));
}

/** Icons + localized tooltips; re-run on locale switch. */
export function localizeChrome(): void {
  const f = sb.files;
  iconize(f.collapseAllEl, "chevrons-down-up", "web.files.collapse_all");
  iconize(f.expandAllEl, "chevrons-up-down", "web.files.expand_all");
  iconize(f.refreshEl, "refresh", "web.files.refresh");
  iconize(f.backEl, "arrow-left", "web.files.back");
  iconize(f.fwdEl, "arrow-right", "web.files.forward");
  iconize(f.detailAttachEl, "paperclip", "web.files.attach");
  const wide = viewerFull();
  iconize(f.wideEl, wide ? "panel-left" : "panel", wide ? "web.files.narrow" : "web.files.wide");
  iconize(document.getElementById("filesClose"), "x", "web.files.close");
}

/** Refreshes every control's `disabled` flag + the expand cap note. */
export function syncChrome(history: ViewerHistory): void {
  const f = sb.files;
  const hasWs = Boolean(f.workspace);
  if (f.collapseAllEl) f.collapseAllEl.disabled = !hasWs || f.expanded.size === 0;
  if (f.expandAllEl) f.expandAllEl.disabled = !hasWs || f.expanding;
  if (f.refreshEl) f.refreshEl.disabled = !hasWs;
  if (f.backEl) f.backEl.disabled = !canBack(history);
  if (f.fwdEl) f.fwdEl.disabled = !canForward(history);
  if (f.detailAttachEl) f.detailAttachEl.disabled = !f.selectedPath;
  // Nothing to take over from the tree while no file is open.
  if (f.wideEl) f.wideEl.disabled = !f.selectedPath;
  const tree = f.treeEl;
  if (!tree) return;
  const note = tree.querySelector(".fcapped");
  if (f.expandCapped && !note) {
    tree.appendChild(el("div", "fdim wn fcapped", t("web.files.expand_capped", { n: EXPAND_DIR_CAP })));
  } else if (!f.expandCapped && note) {
    note.remove();
  }
}