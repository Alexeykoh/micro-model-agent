// Viewer history for the Files tab: a bounded stack of visited files with
// back/forward semantics (browser-style). Pure state — no DOM, no fetch — so
// the dedup/cap rules can be reasoned about (and tested) on their own.
//
// Reuse-on-forward matters: clicking a file you already visited *before* the
// current position moves the cursor instead of piling up duplicates, which is
// what makes `←` feel predictable.
export const HISTORY_CAP = 50;

export interface ViewerHistory {
  stack: string[];
  index: number;
}

export function createHistory(): ViewerHistory {
  return { stack: [], index: -1 };
}

/** Current entry, or null when nothing was opened yet. */
export function current(h: ViewerHistory): string | null {
  return h.index >= 0 && h.index < h.stack.length ? h.stack[h.index] : null;
}

export function canBack(h: ViewerHistory): boolean {
  return h.index > 0;
}

export function canForward(h: ViewerHistory): boolean {
  return h.index >= 0 && h.index < h.stack.length - 1;
}

/**
 * Records `path` as the current entry.
 * - A repeat of the current entry is a no-op (double click, refresh).
 * - A path found ahead of the cursor moves the cursor there (forward reuse).
 * - Otherwise the forward tail is dropped and `path` is appended.
 */
export function push(h: ViewerHistory, path: string): void {
  if (current(h) === path) return;
  const ahead = h.stack.indexOf(path, h.index + 1);
  if (ahead >= 0) {
    h.index = ahead;
    return;
  }
  h.stack = h.stack.slice(0, h.index + 1);
  h.stack.push(path);
  if (h.stack.length > HISTORY_CAP) h.stack.shift();
  h.index = h.stack.length - 1;
}

/** Moves the cursor, returning the new entry or null when it can't move. */
export function goBack(h: ViewerHistory): string | null {
  if (!canBack(h)) return null;
  h.index -= 1;
  return current(h);
}

export function goForward(h: ViewerHistory): string | null {
  if (!canForward(h)) return null;
  h.index += 1;
  return current(h);
}

export function resetHistory(h: ViewerHistory): void {
  h.stack = [];
  h.index = -1;
}