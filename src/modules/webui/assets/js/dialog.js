// Chrome primitives: save toast + generic confirmation dialog.
// Leaf module (dom + i18n only) so tabs and settings can both use it.
import { saveIndicator } from "./dom.js";
import { t } from "./i18n.js";

let indicatorTimer = null;
const indicatorQueue = [];
let indicatorShowing = false;

function showNextIndicator() {
if (!saveIndicator) return;
const next = indicatorQueue.shift();
if (next === undefined) {
  indicatorShowing = false;
  return;
}
indicatorShowing = true;
saveIndicator.textContent = next.msg;
saveIndicator.classList.toggle("fail", !!next.fail);
saveIndicator.classList.add("show");
clearTimeout(indicatorTimer);
indicatorTimer = setTimeout(() => {
  saveIndicator.classList.remove("show");
  // Brief gap so a repeated message visibly re-appears instead of blending.
  setTimeout(showNextIndicator, 150);
}, 2400);
}

// Save toast. Overlapping messages queue (cap 3) instead of overwriting —
// a single message behaves exactly as before (2.4s, then hide).
export function setIndicator(msg, fail) {
if (!saveIndicator) return;
indicatorQueue.push({ msg, fail });
if (indicatorQueue.length > 3) indicatorQueue.splice(0, indicatorQueue.length - 3);
if (!indicatorShowing) showNextIndicator();
}

// Keep Tab cycling inside an open overlay dialog (focus trap). The confirm
// dialog keeps its own two-button variant below — it always traps, even with
// a single visible action.
export function trapTab(container, e) {
if (e.key !== "Tab") return;
const items = Array.from(
  container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
).filter((node) => node.offsetParent !== null);
if (!items.length) return;
const first = items[0];
const last = items[items.length - 1];
if (e.shiftKey && document.activeElement === first) {
  e.preventDefault();
  last.focus();
} else if (!e.shiftKey && document.activeElement === last) {
  e.preventDefault();
  first.focus();
}
}

export const confirmOverlay = document.getElementById("confirmOverlay");
const confirmTitle = document.getElementById("confirmTitle");
const confirmMsg = document.getElementById("confirmMsg");
const confirmAccept = document.getElementById("confirmAccept");
const confirmCancel = document.getElementById("confirmCancel");
let confirmOnAccept = null;
let confirmReturnFocus = null;

export function openConfirm(opts) {
  if (!confirmOverlay) return;
  confirmReturnFocus = document.activeElement;
  confirmTitle.textContent = opts.title || "";
  confirmMsg.textContent = opts.body || "";
  confirmAccept.textContent = opts.acceptLabel || t("web.sessions.delete");
  confirmCancel.textContent = opts.cancelLabel || t("web.action.cancel");
  confirmOnAccept = opts.onAccept || null;
  confirmOverlay.classList.add("open");
  setTimeout(() => confirmCancel.focus(), 0);
}

export function closeConfirm() {
  if (!confirmOverlay || !confirmOverlay.classList.contains("open")) return;
  confirmOverlay.classList.remove("open");
  confirmOnAccept = null;
  if (confirmReturnFocus && confirmReturnFocus.focus) confirmReturnFocus.focus();
  confirmReturnFocus = null;
}

if (confirmOverlay) {
  confirmCancel.addEventListener("click", closeConfirm);
  confirmAccept.addEventListener("click", () => {
    const fn = confirmOnAccept;
    closeConfirm();
    if (fn) fn();
  });
  confirmOverlay.addEventListener("click", (e) => {
    // Keep clicks inside the dialog from reaching the global handler, so the
    // sessions dropdown stays open behind it.
    e.stopPropagation();
    if (e.target === confirmOverlay) closeConfirm();
  });
  // Keep Tab between the two actions while the dialog is open.
  confirmOverlay.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    (document.activeElement === confirmAccept ? confirmCancel : confirmAccept).focus();
  });
}
