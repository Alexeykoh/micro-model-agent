// Chrome primitives: save toast + generic confirmation dialog.
// Leaf module (dom + i18n only) so tabs and settings can both use it.
import { t } from "./i18n.js";

/** Resolved lazily so DOM tests sharing one process still hit their own node. */
function saveIndicatorEl(): HTMLElement | null {
  return document.getElementById("saveIndicator");
}

interface IndicatorMessage {
  msg: string;
  fail?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: opaque timer handle.
let indicatorTimer: any = null;
const indicatorQueue: IndicatorMessage[] = [];
let indicatorShowing = false;

function showNextIndicator(): void {
  const saveIndicator = saveIndicatorEl();
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
    const si = saveIndicatorEl();
    if (si) si.classList.remove("show");
    // Brief gap so a repeated message visibly re-appears instead of blending.
    setTimeout(showNextIndicator, 150);
  }, 2400);
}

// Save toast. Overlapping messages queue (cap 3) instead of overwriting —
// a single message behaves exactly as before (2.4s, then hide).
export function setIndicator(msg: string, fail?: boolean): void {
  const saveIndicator = saveIndicatorEl();
  if (!saveIndicator) return;
  indicatorQueue.push({ msg, fail });
  if (indicatorQueue.length > 3) indicatorQueue.splice(0, indicatorQueue.length - 3);
  if (!indicatorShowing) showNextIndicator();
}

// Keep Tab cycling inside an open overlay dialog (focus trap). The confirm
// dialog keeps its own two-button variant below — it always traps, even with
// a single visible action.
export function trapTab(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const items = Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
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

/** Lazy resolver for the confirm dialog nodes (see saveIndicatorEl). */
function confirmNodes(): {
  overlay: HTMLElement | null;
  title: HTMLElement | null;
  msg: HTMLElement | null;
  accept: HTMLElement | null;
  cancel: HTMLElement | null;
} {
  return {
    overlay: document.getElementById("confirmOverlay"),
    title: document.getElementById("confirmTitle"),
    msg: document.getElementById("confirmMsg"),
    accept: document.getElementById("confirmAccept"),
    cancel: document.getElementById("confirmCancel"),
  };
}

export function getConfirmOverlay(): HTMLElement | null {
  return confirmNodes().overlay;
}
const getConfirmTitle = (): HTMLElement | null => confirmNodes().title;
const getConfirmMsg = (): HTMLElement | null => confirmNodes().msg;
const getConfirmAccept = (): HTMLElement | null => confirmNodes().accept;
const getConfirmCancel = (): HTMLElement | null => confirmNodes().cancel;

let confirmOnAccept: (() => void) | null = null;
let confirmReturnFocus: HTMLElement | null = null;

const confirmWired = new WeakSet<HTMLElement>();

function wireConfirm(overlay: HTMLElement): void {
  if (confirmWired.has(overlay)) return;
  confirmWired.add(overlay);
  const cancelEl = getConfirmCancel();
  const acceptEl = getConfirmAccept();
  cancelEl?.addEventListener("click", closeConfirm);
  acceptEl?.addEventListener("click", () => {
    const fn = confirmOnAccept;
    closeConfirm();
    if (fn) fn();
  });
  overlay.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === overlay) closeConfirm();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const accept = getConfirmAccept();
    const cancel = getConfirmCancel();
    if (accept && cancel) (document.activeElement === accept ? cancel : accept).focus();
  });
}
export interface ConfirmOptions {
  title?: string;
  body?: string;
  acceptLabel?: string;
  cancelLabel?: string;
  onAccept?: () => void;
}

export function openConfirm(opts: ConfirmOptions): void {
  const confirmOverlay = getConfirmOverlay();
  if (!confirmOverlay) return;
  wireConfirm(confirmOverlay);
  confirmReturnFocus = document.activeElement as HTMLElement | null;
  const titleEl = getConfirmTitle();
  const msgEl = getConfirmMsg();
  const acceptEl = getConfirmAccept();
  const cancelEl = getConfirmCancel();
  if (titleEl) titleEl.textContent = opts.title || "";
  if (msgEl) msgEl.textContent = opts.body || "";
  if (acceptEl) acceptEl.textContent = opts.acceptLabel || t("web.sessions.delete");
  if (cancelEl) cancelEl.textContent = opts.cancelLabel || t("web.action.cancel");
  confirmOnAccept = opts.onAccept || null;
  confirmOverlay.classList.add("open");
  setTimeout(() => {
    const cancel = getConfirmCancel();
    if (cancel) cancel.focus();
  }, 0);
}

export function closeConfirm(): void {
  const confirmOverlay = getConfirmOverlay();
  if (!confirmOverlay || !confirmOverlay.classList.contains("open")) return;
  confirmOverlay.classList.remove("open");
  confirmOnAccept = null;
  if (confirmReturnFocus && confirmReturnFocus.focus) confirmReturnFocus.focus();
  confirmReturnFocus = null;
}
