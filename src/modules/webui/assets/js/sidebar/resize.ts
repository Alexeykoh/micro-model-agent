// Resizable sidebar column (U7). The Files tab already had a drag-to-resize
// tree column (`files/split.ts`); this lifts the same mechanics to the whole
// sidebar: a vertical separator on the chat/sidebar boundary, clamped width,
// persisted in localStorage and operable from the keyboard.
//
// The stored value is a *desired* width, not the layout truth: the drawer
// (`@media (max-width: 1024px)`) overrides `.sb` width in CSS and hides the
// handle, and the clamp re-runs against the viewport so a width dragged on a
// 1920px monitor does not eat a 1280px chat area.
import { t } from "../i18n.js";

export const SIDEBAR_WIDTH_KEY = "mma-sidebar-w";
export const SIDEBAR_MIN = 300;
export const SIDEBAR_MAX = 760;
/** Room the chat column must keep before the sidebar is allowed to grow. */
export const CHAT_MIN = 420;

let node: HTMLElement | null = null;
let handle: HTMLElement | null = null;
let width = readStored();
let wired = false;

function readStored(): number {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch {
    return 0;
  }
}

function persist(): void {
  try {
    if (width > 0) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    else localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  } catch {
    /* private mode */
  }
}

/** Upper bound for the current viewport: never squeeze the chat below CHAT_MIN. */
export function sidebarMax(vw = typeof window === "undefined" ? 0 : window.innerWidth): number {
  if (!vw) return SIDEBAR_MAX;
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(vw - CHAT_MIN)));
}

/** Clamps a desired width; `0` means "follow the responsive default". */
export function clampSidebarWidth(px: number, vw?: number): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  return Math.min(sidebarMax(vw), Math.max(SIDEBAR_MIN, Math.round(px)));
}

/** Pushes the current width into the DOM. Idempotent. */
export function applySidebarWidth(): void {
  width = clampSidebarWidth(width);
  if (!node) return;
  if (width > 0) node.style.setProperty("--sb-w", `${width}px`);
  else node.style.removeProperty("--sb-w");
  if (!handle) return;
  handle.setAttribute("aria-valuemin", String(SIDEBAR_MIN));
  handle.setAttribute("aria-valuemax", String(sidebarMax()));
  if (width > 0) handle.setAttribute("aria-valuenow", String(width));
  else handle.removeAttribute("aria-valuenow");
}

/** Sets the width (clamped) and persists it unless `persist === false`. */
export function setSidebarWidth(px: number, persistWidth = true): number {
  width = clampSidebarWidth(px);
  if (persistWidth) persist();
  applySidebarWidth();
  return width;
}

/** Back to the viewport-relative default; also clears the stored value. */
export function resetSidebarWidth(): void {
  width = 0;
  persist();
  applySidebarWidth();
}

export function sidebarWidth(): number {
  return width;
}

/** Localizes the separator's accessible name and tooltip. */
export function applySidebarResizeI18n(): void {
  if (!handle) return;
  const label = t("web.sidebar.resize");
  handle.setAttribute("aria-label", label);
  handle.title = t("web.sidebar.resize_hint");
}

/**
 * Wires the separator once. Later calls only refresh the node refs, matching
 * `initSplit` so a drawer remount does not stack listeners.
 */
export function initSidebarResize(sbEl: HTMLElement | null, sep: HTMLElement | null): void {
  node = sbEl;
  handle = sep;
  applySidebarWidth();
  applySidebarResizeI18n();
  if (wired || !handle) return;
  wired = true;

  const startDrag = (ev: PointerEvent): void => {
    if (!node) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = width || node.getBoundingClientRect().width || SIDEBAR_MIN;
    document.body.classList.add("sb-resizing");
    try {
      handle?.setPointerCapture(ev.pointerId);
    } catch {
      /* no pointer capture */
    }
    const move = (e: PointerEvent): void => {
      // Dragging left widens a right-hand column.
      setSidebarWidth(startW - (e.clientX - startX), false);
    };
    const up = (): void => {
      document.body.classList.remove("sb-resizing");
      handle?.removeEventListener("pointermove", move);
      handle?.removeEventListener("pointerup", up);
      handle?.removeEventListener("pointercancel", up);
      persist();
    };
    handle?.addEventListener("pointermove", move);
    handle?.addEventListener("pointerup", up);
    handle?.addEventListener("pointercancel", up);
  };

  handle.addEventListener("pointerdown", startDrag);

  const step = (ev: KeyboardEvent): void => {
    const current = width || node?.getBoundingClientRect().width || 0;
    const delta = ev.shiftKey ? 40 : 12;
    if (ev.key === "ArrowLeft") setSidebarWidth(current + delta);
    else if (ev.key === "ArrowRight") setSidebarWidth(current - delta);
    else if (ev.key === "Home") resetSidebarWidth();
    else return;
    ev.preventDefault();
  };
  handle.addEventListener("keydown", step);
  handle.addEventListener("dblclick", resetSidebarWidth);

  // A window resize can make a persisted width illegal (max depends on vw).
  window.addEventListener("resize", applySidebarWidth);
}
