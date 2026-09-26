// Chrome primitives: save toast + generic confirmation dialog.
// Leaf module (dom + i18n only) so tabs and settings can both use it.
import { saveIndicator } from "./dom.js";
import { t } from "./i18n.js";

let indicatorTimer = null;

  export function setIndicator(msg, fail) {
    if (!saveIndicator) return;
    saveIndicator.textContent = msg;
    saveIndicator.classList.toggle("fail", !!fail);
    saveIndicator.classList.add("show");
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => saveIndicator.classList.remove("show"), 2400);
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
