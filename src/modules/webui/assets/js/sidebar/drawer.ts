// Narrow-viewport sidebar: at ≤1024px the sidebar is an overlay drawer over the
// chat instead of a 679px column beside it (styles.css owns the geometry).
//
// Why a module instead of three lines in app.ts: the drawer is a modal surface,
// so it needs more than a class toggle — a backdrop, Esc/click-outside to
// close, a focus trap, a scroll lock, and synchronization with the breakpoint.
// Without the `matchMedia` listener, `body.sb-open` outlived the viewport that
// justified it: rotate a tablet and the drawer stayed "open" over a layout that
// no longer had one (and reappeared open on the way back).
import { trapTab } from "../dialog.js";
import { NARROW_MQ } from "./state.js";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"]), [role="treeitem"]';

interface DrawerNodes {
  btn: HTMLButtonElement | null;
  backdrop: HTMLElement | null;
  panel: HTMLElement | null;
  bars: HTMLElement[];
}

let nodes: DrawerNodes = { btn: null, backdrop: null, panel: null, bars: [] };
let wired = false;
let isOpen = false;
let restoreFocusTo: HTMLElement | null = null;

function body(): HTMLElement | null {
  return document.body;
}

/**
 * Height of the bars the drawer slides under. Measured, not hardcoded: on
 * phones a second bar (the session sub-bar) appears below the breakpoint, so a
 * constant top offset left the drawer tucked under it or floating short.
 */
function barHeight(): number {
  return nodes.bars.reduce((sum, el) => sum + (el.offsetHeight || 0), 0);
}

function applyInset(): void {
  if (!nodes.panel) return;
  nodes.panel.style.setProperty("--sb-inset", `${barHeight()}px`);
}

/** True while the drawer is open (used by guards and tests). */
export function sidebarDrawerOpen(): boolean {
  return isOpen;
}

/**
 * Opens or closes the drawer. On close the focus returns to the toggle, so a
 * keyboard user is not dropped back at the top of the document.
 */
export function setSidebarDrawer(open: boolean): void {
  const root = body();
  if (!root) return;
  if (open === isOpen) {
    applyInset();
    return;
  }
  isOpen = open;
  root.classList.toggle("sb-open", open);
  nodes.btn?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    restoreFocusTo = (document.activeElement as HTMLElement) || null;
    applyInset();
    // Dialog semantics only while it actually is one: on desktop the same
    // element is a plain column in the layout, not a modal.
    nodes.panel?.setAttribute("role", "dialog");
    nodes.panel?.setAttribute("aria-modal", "true");
    const active = nodes.panel?.querySelector<HTMLElement>('.sb-tab.on') ||
      nodes.panel?.querySelector<HTMLElement>(FOCUSABLE);
    active?.focus();
  } else {
    nodes.panel?.removeAttribute("role");
    nodes.panel?.removeAttribute("aria-modal");
    nodes.panel?.style.removeProperty("--sb-inset");
    const back = restoreFocusTo || nodes.btn;
    restoreFocusTo = null;
    back?.focus?.();
  }
}

export function toggleSidebarDrawer(): void {
  setSidebarDrawer(!isOpen);
}

/**
 * Keeps the drawer honest across a viewport change: growing past the breakpoint
 * restores the column (and the stale `sb-open` with it), shrinking back reuses
 * the closed state. Also re-measures the bar inset — a rotation changes the
 * bar heights, and a landscape phone gets the sub-bar only below 760px.
 */
function syncToViewport(): void {
  if (mqMatches()) {
    if (isOpen) applyInset();
    return;
  }
  if (!isOpen) return;
  isOpen = false;
  document.body.classList.remove("sb-open");
  nodes.btn?.setAttribute("aria-expanded", "false");
  nodes.panel?.removeAttribute("role");
  nodes.panel?.removeAttribute("aria-modal");
  nodes.panel?.style.removeProperty("--sb-inset");
  restoreFocusTo = null;
}

function mqMatches(): boolean {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia(NARROW_MQ).matches
    : false;
}

/** An open overlay is modal itself — Esc belongs to the topmost surface. */
function overlayOpen(): boolean {
  return Array.from(document.querySelectorAll(".overlay")).some((el) =>
    el.classList.contains("open"),
  );
}

export function initSidebarDrawer(): void {
  nodes = {
    btn: document.getElementById("toggleSidebar") as HTMLButtonElement | null,
    backdrop: document.getElementById("sbBackdrop"),
    // Queried, not taken from `sb.el`: the drawer must find its own panel
    // without depending on `initSidebar()` having run first.
    panel: document.querySelector<HTMLElement>(".sb"),
    bars: [".bar-top", ".bar-sub"]
      .map((sel) => document.querySelector<HTMLElement>(sel))
      .filter((el): el is HTMLElement => !!el),
  };
  if (wired) {
    applyInset();
    return;
  }
  if (!nodes.btn && !nodes.panel) return;
  wired = true;

  nodes.btn?.addEventListener("click", () => toggleSidebarDrawer());
  nodes.backdrop?.addEventListener("click", () => setSidebarDrawer(false));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen && !overlayOpen()) {
      e.preventDefault();
      setSidebarDrawer(false);
      return;
    }
    if (e.key === "Tab" && isOpen && nodes.panel) trapTab(nodes.panel, e);
  });

  // The feed must not scroll away under the drawer's finger, and the bar inset
  // is measured: both need a fresh read on resize, not only on open.
  window.addEventListener("resize", () => {
    if (isOpen) applyInset();
  });

  if (typeof window.matchMedia === "function") {
    const mq = window.matchMedia(NARROW_MQ);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", syncToViewport);
    }
  }
  syncToViewport();
}