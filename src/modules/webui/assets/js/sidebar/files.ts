// Files tab for `mma web`: lazy project file tree, read-only viewer in a
// resizable split, viewer history (back/forward) and tree expand/collapse
// controls. Orchestrator: state transitions and lazy listing fetches live here,
// rendering/chrome/keyboard live in `./files/*`.
//
// Attach semantics: a file is attached by inserting its workspace-relative path
// (backticked) into the active draft — no new attachment channel; the agent
// reads the path itself via `read_file`.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { el } from "../dom.js";
import type { Dict } from "../core/store/types.js";
import { sb, type FileEntry } from "./state.js";
import { initSplit, applySplit, toggleViewerFull, setViewerFull } from "./files/split.js";
import {
  createHistory, push as pushHistory, goBack, goForward, resetHistory, type ViewerHistory,
} from "./files/history.js";
import { initFilesKeys, focusTreeRow, initGlobalFilesKeys } from "./files/keys.js";
import {
  initTreeDeps, renderDir, paintCursor, visibleRows, revealInTree, revealFile,
} from "./files/tree.js";
import { initCrumbDeps, renderCrumbs, clearCrumbs } from "./files/crumbs.js";
import { syncChrome, localizeChrome, iconize } from "./files/chrome.js";
import { fetchFile, paintFile, paintLoading } from "./files/view.js";
import { markAndScrollToLine } from "./files/line-mark.js";
import { initSearch, resetSearch, renderSearch } from "./files/search.js";
export { lineScrollTop } from "./files/line-mark.js";
import {
  initExpandDeps,
  collapseAll,
  expandAll,
  expandToDepth,
} from "./files/expand.js";

interface FilesDeps {
  insertPath: (path: string) => void;
}

let deps: FilesDeps = { insertPath: () => {} };
let history: ViewerHistory = createHistory();
let dirty = true;
const pending = new Map<string, Promise<void>>();

/** Tab hub/app injects the draft-insertion hook; keeps the DAG acyclic. */
export function initFiles(d: Partial<FilesDeps>): void {
  deps = { ...deps, ...d };
  const f = sb.files;
  const byId = <T extends HTMLElement>(id: string): T | null =>
    document.getElementById(id) as T | null;
  f.sideEl = byId("filesSide");
  f.splitterEl = byId("filesSplitter");
  f.treeEl = byId("filesTree");
  f.detailEl = byId("filesDetail");
  f.crumbEl = byId("filesCrumbs");
  f.backEl = byId("filesBack");
  f.fwdEl = byId("filesFwd");
  f.wideEl = byId("filesWide");
  f.collapseAllEl = byId("filesCollapseAll");
  f.expandAllEl = byId("filesExpandAll");
  f.refreshEl = byId("filesRefresh");
  f.detailBodyEl = byId("filesBody");
  f.detailAttachEl = byId("filesAttach");
  f.searchEl = byId<HTMLInputElement>("filesSearch");
  f.searchResultsEl = byId("filesSearchResults");
  const close = byId<HTMLButtonElement>("filesClose");

  initSearch({ openFile: (p, line) => void openFile(p, line) });
  initTreeDeps({
    ensureListing, toggleDir, openFile: (p) => void openFile(p),
    insertPath: deps.insertPath, markDirty, render: renderFilesTree,
  });
  initCrumbDeps({ reveal: revealInTree });
  initExpandDeps({
    markDirty,
    render: renderFilesTree,
    syncChrome: () => syncChrome(history),
    ensureListing,
  });

  localizeChrome();
  close?.addEventListener("click", () => closeFile());
  if (f.splitterEl) f.splitterEl.title = t("web.files.tree_width");
  if (f.treeEl) f.treeEl.setAttribute("aria-label", t("web.sidebar.tab_files"));

  f.detailAttachEl?.addEventListener("click", () => {
    if (f.selectedPath) deps.insertPath(f.selectedPath);
  });
  f.backEl?.addEventListener("click", () => void step(-1));
  f.fwdEl?.addEventListener("click", () => void step(1));
  f.wideEl?.addEventListener("click", () => {
    const full = toggleViewerFull();
    iconize(f.wideEl, full ? "panel-left" : "panel", full ? "web.files.narrow" : "web.files.wide");
  });
  f.collapseAllEl?.addEventListener("click", () => collapseAll());
  f.expandAllEl?.addEventListener("click", () => void expandAll());
  f.refreshEl?.addEventListener("click", () => sidebarFilesChanged());

  initSplit({ pane: byId("pane-files"), side: f.sideEl, splitter: f.splitterEl });
  applySplit();
  initFilesKeys(f.treeEl, {
    rows: visibleRows,
    toggleDir,
    openFile: (p) => void openFile(p),
    isExpanded: (p) => f.expanded.has(p),
    expandToDepth,
    getCursor: () => f.cursor,
    setCursor: (p) => { f.cursor = p; },
    onCursorMove: paintCursor,
  });
  initGlobalFilesKeys({
    step: (delta) => void step(delta),
    closeViewer: closeFile,
    isOpen: () => Boolean(f.selectedPath),
  });
}


/** Re-render request; DOM is only touched when something actually changed. */
function markDirty(): void {
  dirty = true;
}

/** Called from `renderActiveState` with the host snapshot. */
export function sidebarFilesState(host: Dict): void {
  const f = sb.files;
  const ws = String((host && host.workspace) || "");
  if (ws !== f.workspace) {
    f.workspace = ws;
    f.listings.clear();
    f.expanded.clear();
    f.truncated.clear();
    f.errored.clear();
    f.selectedPath = null;
    f.cursor = null;
    f.expandCapped = false;
    f.crumbsOpen = false;
    resetHistory(history);
    resetSearch();
    if (f.detailEl) f.detailEl.hidden = true;
    setViewerFull(false);
    clearCrumbs();
    syncChrome(history);
    markDirty();
  }
  if (sb.active === "files") renderFilesTree();
}

/** Fetches and caches one directory listing (deduped; no DOM side-effects). */
function ensureListing(path: string): Promise<void> {
  const f = sb.files;
  if (f.listings.has(path)) return Promise.resolve();
  const existing = pending.get(path);
  if (existing) return existing;
  const p = api<{ entries: FileEntry[]; truncated: boolean }>(
    "/api/files?path=" + encodeURIComponent(path),
  )
    .then((r) => {
      if (r.ok && r.data) {
        f.listings.set(path, r.data.entries || []);
        if (r.data.truncated) f.truncated.add(path);
        f.errored.delete(path);
      } else {
        f.errored.add(path);
      }
      markDirty();
    })
    .finally(() => pending.delete(path));
  pending.set(path, p);
  return p;
}

/** Forces a re-render (locale switch → localized empty/loading/error labels). */
export function refreshFilesTree(): void {
  localizeChrome();
  renderSearch();
  markDirty();
  renderFilesTree();
}

/** Renders the tree from cached listings, lazily fetching expanded directories. */
export function renderFilesTree(): void {
  const f = sb.files;
  const tree = f.treeEl;
  if (!tree || !dirty) return;
  dirty = false;
  tree.textContent = "";
  if (!f.workspace) {
    tree.appendChild(el("div", "fdim", t("web.files.no_workspace")));
    syncChrome(history);
    return;
  }
  if (!f.listings.has("")) {
    tree.appendChild(el("div", "fdim", f.errored.has("") ? t("web.files.error") : t("web.files.loading")));
    syncChrome(history);
    void ensureListing("").then(renderFilesTree);
    return;
  }
  renderDir(tree, "", 0);
  syncChrome(history);
}

/** Expands/collapses a directory (fetches its listing on first expand). */
function toggleDir(path: string): void {
  const f = sb.files;
  if (f.expanded.has(path)) {
    f.expanded.delete(path);
  } else {
    f.expanded.add(path);
    if (!f.listings.has(path)) void ensureListing(path).then(renderFilesTree);
  }
  markDirty();
  renderFilesTree();
}

/** Opens a file in the read-only viewer and records it in the history. */
export async function openFile(path: string, line?: number): Promise<void> {
  const f = sb.files;
  f.selectedPath = path;
  pushHistory(history, path);
  renderCrumbs(path);
  if (f.detailEl) f.detailEl.hidden = false;
  paintLoading(f.detailBodyEl);
  syncChrome(history);
  markDirty();
  renderFilesTree();
  paintFile(f.detailBodyEl, path, await fetchFile(path));
  if (typeof line === "number" && line > 0) markAndScrollToLine(f.detailBodyEl, line);
}

/**
 * Приводит путь из чата к workspace-относительному posix-пути дерева Files:
 * срезает префикс workspace (регистронезависимо, для Windows) и ведущий `./`.
 */
function normalizePath(raw: string): string {
  let p = String(raw || "").replace(/\\/g, "/").trim();
  const ws = sb.files.workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  if (ws && (p === ws || p.toLowerCase().startsWith(ws.toLowerCase() + "/"))) {
    p = p === ws ? "" : p.slice(ws.length + 1);
  }
  return p.replace(/^\.?\//, "").replace(/\/+$/, "");
}

/**
 * Открывает файл из чата в вкладке Files: раскрывает дерево до файла и
 * показывает его во вьюере. Переключение вкладки/дровера — на вызывающем
 * (app.js), чтобы `files.js` не тянул `core.js` (цикл импортов).
 */
export async function openFileInTree(raw: string, line?: number): Promise<void> {
  const rel = normalizePath(raw);
  if (!rel) return;
  await revealFile(rel);
  await openFile(rel, line);
}

/** Closes the viewer and clears the selection (history is kept). */
export function closeFile(): void {
  const f = sb.files;
  f.selectedPath = null;
  if (f.detailEl) f.detailEl.hidden = true;
  // The tree must come back: a hidden tree plus a closed viewer is a blank pane.
  setViewerFull(false);
  clearCrumbs();
  localizeChrome();
  syncChrome(history);
  markDirty();
  renderFilesTree();
}

/** Walks the viewer history by `delta` (-1 back, +1 forward). */
async function step(delta: number): Promise<void> {
  const next = delta < 0 ? goBack(history) : goForward(history);
  if (next) await openFile(next);
}

/** Invalidates expanded listings and re-reads them (watcher/SSE `files`). */
export function sidebarFilesChanged(): void {
  const f = sb.files;
  const paths = ["", ...f.expanded];
  paths.forEach((p) => {
    f.listings.delete(p);
    f.truncated.delete(p);
    f.errored.delete(p);
  });
  markDirty();
  renderFilesTree();
  const reload = f.selectedPath ? openFile(f.selectedPath) : Promise.resolve();
  void Promise.all([...paths.map(ensureListing), reload]).then(() => {
    if (f.cursor) focusTreeRow(f.treeEl, f.cursor);
    renderFilesTree();
  });
}

