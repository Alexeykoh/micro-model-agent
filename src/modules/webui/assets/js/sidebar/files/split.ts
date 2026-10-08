// Split layout for the Files tab: resizable tree column + "hide the tree"
// toggle. Owns layout state only (width + full-viewer flag, persisted in
// localStorage); the tab module owns content. Kept apart from `files.ts` so the
// tab module stays readable and the clamp/drag math lives in one place.
//
// Why a split at all: opening a file used to hide the whole tree
// (`#pane-files:has(.files-detail:not([hidden]) .files-tree){display:none}`),
// so switching files meant closing, re-navigating and re-expanding folders.
export const WIDTH_KEY = "mma-files-tree-w";
export const TREE_MIN = 200;
export const TREE_MAX = 480;
export const TREE_DEFAULT = 240;

interface SplitNodes {
  pane: HTMLElement | null;
  side: HTMLElement | null;
  splitter: HTMLElement | null;
}

let nodes: SplitNodes = { pane: null, side: null, splitter: null };
let width = readStoredWidth();
let full = false;
let wired = false;

function readStoredWidth(): number {
  try {
    return clampWidth(Number(localStorage.getItem(WIDTH_KEY)));
  } catch {
    return TREE_DEFAULT;
  }
}

function clampWidth(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return TREE_DEFAULT;
  return Math.min(TREE_MAX, Math.max(TREE_MIN, Math.round(px)));
}

function persistWidth(): void {
  try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* private mode */ }
}

/** Sets the tree column width (clamped) and persists it. */
function setTreeWidth(px: number, persist = true): number {
  width = clampWidth(px);
  if (persist) persistWidth();
  applySplit();
  return width;
}

/** Wires the splitter once; later calls only refresh the node refs. */
export function initSplit(d: Partial<SplitNodes>): void {
  nodes = { ...nodes, ...d };
  if (wired || !nodes.splitter) return;
  wired = true;
  const handle = nodes.splitter;
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = width;
    try { handle.setPointerCapture(ev.pointerId); } catch { /* no capture support */ }
    const move = (e: PointerEvent): void => { setTreeWidth(startW + (e.clientX - startX), false); };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      persistWidth();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  // Keyboard-resizable separator: a mouse-only handle is a dead end.
  handle.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? 40 : 12;
    if (ev.key === "ArrowLeft") setTreeWidth(width - step);
    else if (ev.key === "ArrowRight") setTreeWidth(width + step);
    else if (ev.key === "Home") setTreeWidth(TREE_DEFAULT);
    else return;
    ev.preventDefault();
  });
  handle.addEventListener("dblclick", () => setTreeWidth(TREE_DEFAULT));
}

/** Pushes width/visibility into the DOM. Idempotent. */
export function applySplit(): void {
  if (nodes.side) {
    nodes.side.style.width = `${width}px`;
    nodes.side.hidden = full;
  }
  if (nodes.pane) nodes.pane.classList.toggle("f-full", full);
  if (nodes.splitter) nodes.splitter.hidden = full;
}

export function treeWidth(): number {
  return width;
}

export function viewerFull(): boolean {
  return full;
}

/** Toggles "tree steps aside, viewer takes the whole sidebar". */
export function toggleViewerFull(): boolean {
  return setViewerFull(!full);
}

/**
 * Sets the viewer-only mode explicitly. Closing a file must call this with
 * `false`: leaving the tree hidden with no viewer open shows the user nothing.
 */
export function setViewerFull(on: boolean): boolean {
  if (full === on) return full;
  full = on;
  applySplit();
  return full;
}