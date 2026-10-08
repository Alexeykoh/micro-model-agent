// Keyboard navigation for the Files tree: a roving cursor over the rendered
// rows (↑/↓ move, ←/→ collapse/descend, Enter acts, Home/End jump, `*`
// expands to the current depth). Rows are a flat, indentation-encoded list, so
// "children" and "parent" are read off `data-depth` instead of a nested model.
//
// Listeners live on the tree element and stop propagation, so these keys don't
// fight the sidebar's global shortcuts (Alt+1..6 tabs, Escape).
export interface TreeKeysDeps {
  /** Visible rows in document order (flat, one `.frow` per node). */
  rows: () => HTMLElement[];
  toggleDir: (path: string) => void;
  openFile: (path: string) => void;
  isExpanded: (path: string) => boolean;
  expandToDepth: () => void;
  getCursor: () => string | null;
  setCursor: (path: string | null) => void;
  onCursorMove: () => void;
}

let deps: TreeKeysDeps | null = null;

function rowPath(row: HTMLElement): string {
  return row.dataset.path || "";
}

function rowDepth(row: HTMLElement): number {
  return Number(row.dataset.depth || 0);
}

function rowIsDir(row: HTMLElement): boolean {
  return row.dataset.kind === "dir";
}

function focusRow(row: HTMLElement | null): void {
  if (!row) return;
  row.focus({ preventScroll: true });
  if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
}

/** Moves the cursor to `path` (or by `delta` rows when path is null). */
function move(path: string | null, delta: number): void {
  if (!deps) return;
  const rows = deps.rows();
  if (rows.length === 0) return;
  const cur = deps.getCursor();
  let idx = cur === null ? -1 : rows.findIndex((r) => rowPath(r) === cur);
  idx = path === null ? idx + delta : rows.findIndex((r) => rowPath(r) === path);
  if (idx < 0 || idx >= rows.length) return;
  deps.setCursor(rowPath(rows[idx]));
  deps.onCursorMove();
  focusRow(rows[idx]);
}

function currentRow(): HTMLElement | null {
  if (!deps) return null;
  const cur = deps.getCursor();
  if (cur === null) return null;
  return deps.rows().find((r) => rowPath(r) === cur) || null;
}

/** First descendant of `row` (the next row with a greater depth). */
function firstChild(row: HTMLElement): HTMLElement | null {
  const depth = rowDepth(row);
  const next = nextRow(row);
  return next && rowDepth(next) > depth ? next : null;
}

/** Nearest ancestor: the closest row above with a smaller depth. */
function parentRow(row: HTMLElement): HTMLElement | null {
  const depth = rowDepth(row);
  const rows = deps ? deps.rows() : [];
  const idx = rows.indexOf(row);
  for (let i = idx - 1; i >= 0; i--) {
    if (rowDepth(rows[i]) < depth) return rows[i];
  }
  return null;
}

function nextRow(row: HTMLElement): HTMLElement | null {
  if (!deps) return null;
  const rows = deps.rows();
  const idx = rows.indexOf(row);
  return idx >= 0 && idx + 1 < rows.length ? rows[idx + 1] : null;
}

function onKeydown(ev: KeyboardEvent): void {
  if (!deps) return;
  const rows = deps.rows();
  if (rows.length === 0) return;
  const row = currentRow();
  const key = ev.key;

  if (key === "ArrowDown" || key === "ArrowUp") {
    if (row === null && key === "ArrowUp") {
      ev.preventDefault();
      move(null, -1);
      return;
    }
    if (row === null && rows.length > 0) {
      ev.preventDefault();
      deps.setCursor(rowPath(rows[0]));
      deps.onCursorMove();
      focusRow(rows[0]);
      return;
    }
    ev.preventDefault();
    move(null, key === "ArrowDown" ? 1 : -1);
    return;
  }

  if (key === "ArrowRight") {
    if (!row) return;
    ev.preventDefault();
    if (rowIsDir(row) && !deps.isExpanded(rowPath(row))) {
      deps.toggleDir(rowPath(row));
      focusRow(currentRow());
    } else if (rowIsDir(row)) {
      const child = firstChild(row);
      if (child) {
        deps.setCursor(rowPath(child));
        deps.onCursorMove();
        focusRow(child);
      }
    }
    return;
  }

  if (key === "ArrowLeft") {
    if (!row) return;
    ev.preventDefault();
    if (rowIsDir(row) && deps.isExpanded(rowPath(row))) {
      deps.toggleDir(rowPath(row));
      focusRow(currentRow());
    } else {
      const parent = parentRow(row);
      if (parent) {
        deps.setCursor(rowPath(parent));
        deps.onCursorMove();
        focusRow(parent);
      }
    }
    return;
  }

  if (key === "Enter" || key === " ") {
    if (!row) return;
    ev.preventDefault();
    if (rowIsDir(row)) {
      deps.toggleDir(rowPath(row));
      focusRow(currentRow());
    } else {
      deps.openFile(rowPath(row));
    }
    return;
  }

  if (key === "Home" || key === "End") {
    ev.preventDefault();
    deps.setCursor(rowPath(key === "Home" ? rows[0] : rows[rows.length - 1]));
    deps.onCursorMove();
    focusRow(deps.rows().find((r) => rowPath(r) === deps!.getCursor()) || null);
    return;
  }

  if (key === "*") {
    ev.preventDefault();
    deps.expandToDepth();
  }
}

export function initFilesKeys(tree: HTMLElement | null, d: TreeKeysDeps): void {
  deps = d;
  if (!tree) return;
  tree.addEventListener("keydown", (ev) => {
    onKeydown(ev);
    if (ev.defaultPrevented) ev.stopPropagation();
  });
}

/** Focuses a rendered row by path (used when the tree changes under a click). */
export function focusTreeRow(tree: HTMLElement | null, path: string): void {
  if (!tree) return;
  const row = Array.from(tree.querySelectorAll<HTMLElement>(".frow")).find(
    (r) => r.dataset.path === path,
  );
  focusRow(row || null);
}

/** Viewer-level shortcuts: Alt+←/→ walk the history, Escape closes the viewer. */
export function initGlobalFilesKeys(d: {
  step: (delta: number) => void;
  closeViewer: () => void;
  isOpen: () => boolean;
}): void {
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement ? String(document.activeElement.tagName) : "";
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (typing) return;
      e.preventDefault();
      d.step(e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (e.key === "Escape" && !typing && d.isOpen()) d.closeViewer();
  });
}