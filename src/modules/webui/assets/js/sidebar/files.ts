// Files tab for `mma web`: lazy project file tree, read-only viewer and
// "attach path" into the composer draft. Split out of `sidebar.js`; leaf module
// (imports only dom/i18n/api/state/md), so the frontend DAG stays acyclic.
//
// Attach semantics: a file is attached by inserting its workspace-relative path
// (backticked) into the active draft — no new attachment channel; the agent
// reads the path itself via `read_file`.
import { el, icon } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { renderMarkdown } from "../../md.js";
import type { Dict } from "../core/store/types.js";
import { sb, type FileEntry } from "./state.js";

interface FilesDeps {
  insertPath: (path: string) => void;
}

let deps: FilesDeps = { insertPath: () => {} };

/** Tab hub/app injects the draft-insertion hook; keeps the DAG acyclic. */
export function initFiles(d: Partial<FilesDeps>): void {
  deps = { ...deps, ...d };
  sb.files.treeEl = document.getElementById("filesTree");
  sb.files.detailEl = document.getElementById("filesDetail");
  sb.files.detailTitleEl = document.getElementById("filesTitle");
  sb.files.detailBodyEl = document.getElementById("filesBody");
  sb.files.detailAttachEl = document.getElementById("filesAttach");
  document.getElementById("filesClose")?.addEventListener("click", closeFile);
  sb.files.detailAttachEl?.addEventListener("click", () => {
    if (sb.files.selectedPath) deps.insertPath(sb.files.selectedPath);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sb.files.selectedPath) closeFile();
  });
}

let workspace = "";
let dirty = true;
const pending = new Map<string, Promise<void>>();
const errored = new Set<string>();
const truncated = new Set<string>();

/** Re-render request; DOM is only touched when something actually changed. */
function markDirty(): void {
  dirty = true;
}

/** Called from `renderActiveState` with the host snapshot. */
export function sidebarFilesState(host: Dict): void {
  const ws = (host && host.workspace) || "";
  if (ws !== workspace) {
    workspace = ws;
    sb.files.listings.clear();
    sb.files.expanded.clear();
    sb.files.selectedPath = null;
    if (sb.files.detailEl) sb.files.detailEl.hidden = true;
    markDirty();
  }
  if (sb.active === "files") renderFilesTree();
}

/** Fetches and caches one directory listing (deduped; no DOM side-effects). */
function ensureListing(path: string): Promise<void> {
  if (sb.files.listings.has(path)) return Promise.resolve();
  const existing = pending.get(path);
  if (existing) return existing;
  const p = api<{ entries: FileEntry[]; truncated: boolean }>(
    "/api/files?path=" + encodeURIComponent(path),
  )
    .then((r) => {
      if (r.ok && r.data) {
        sb.files.listings.set(path, r.data.entries || []);
        if (r.data.truncated) truncated.add(path);
        errored.delete(path);
      } else {
        errored.add(path);
      }
      markDirty();
    })
    .finally(() => pending.delete(path));
  pending.set(path, p);
  return p;
}

/** Forces a re-render (locale switch → localized empty/loading/error labels). */
export function refreshFilesTree(): void {
  markDirty();
  renderFilesTree();
}

/** Renders the tree from cached listings, lazily fetching expanded directories. */
export function renderFilesTree(): void {
  const tree = sb.files.treeEl;
  if (!tree || !dirty) return;
  dirty = false;
  tree.textContent = "";
  if (!workspace) {
    tree.appendChild(el("div", "fdim", t("web.files.no_workspace")));
    return;
  }
  if (!sb.files.listings.has("")) {
    tree.appendChild(el("div", "fdim", errored.has("") ? t("web.files.error") : t("web.files.loading")));
    void ensureListing("").then(renderFilesTree);
    return;
  }
  renderDir(tree, "", 0);
}

/** Renders one directory's rows (recurses into expanded subdirectories). */
function renderDir(parent: HTMLElement, path: string, depth: number): void {
  const entries = sb.files.listings.get(path) || [];
  if (entries.length === 0 && depth === 0) {
    parent.appendChild(el("div", "fdim", t("web.files.empty")));
    return;
  }
  for (const e of entries) {
    const childPath = path ? `${path}/${e.name}` : e.name;
    parent.appendChild(fileRow(e, childPath, depth));
    if (e.type === "dir" && sb.files.expanded.has(childPath)) {
      if (sb.files.listings.has(childPath)) {
        renderDir(parent, childPath, depth + 1);
      } else {
        const p = el("div", "fdim", errored.has(childPath) ? t("web.files.error") : t("web.files.loading"));
        p.style.paddingLeft = `${8 + (depth + 1) * 14}px`;
        parent.appendChild(p);
        void ensureListing(childPath).then(renderFilesTree);
      }
    }
  }
  if (truncated.has(path)) {
    const note = el("div", "fdim", t("web.files.truncated"));
    note.style.paddingLeft = `${8 + depth * 14}px`;
    parent.appendChild(note);
  }
}

/** Builds one tree row (twisty + icon + name + attach button). */
function fileRow(e: FileEntry, childPath: string, depth: number): HTMLElement {
  const isDir = e.type === "dir";
  const sel = !isDir && sb.files.selectedPath === childPath;
  const row = el("div", `frow${isDir ? " dir" : ""}${sel ? " sel" : ""}`);
  row.style.paddingLeft = `${8 + depth * 14}px`;
  const twisty = el("span", "ftw");
  if (isDir) twisty.appendChild(icon(sb.files.expanded.has(childPath) ? "chevron-down" : "chevron-right"));
  row.appendChild(twisty);
  const ic = el("span", "fic");
  ic.appendChild(icon(isDir ? "folder" : "file"));
  row.appendChild(ic);
  row.appendChild(el("span", "fname", e.name));
  if (!isDir) {
    const at = el("button", "fattach");
    at.type = "button";
    at.title = t("web.files.attach");
    at.setAttribute("aria-label", t("web.files.attach"));
    at.appendChild(icon("paperclip"));
    at.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deps.insertPath(childPath);
    });
    row.appendChild(at);
  }
  row.addEventListener("click", () => {
    if (isDir) toggleDir(childPath);
    else void openFile(childPath);
  });
  return row;
}

/** Expands/collapses a directory (fetches its listing on first expand). */
function toggleDir(path: string): void {
  if (sb.files.expanded.has(path)) {
    sb.files.expanded.delete(path);
  } else {
    sb.files.expanded.add(path);
    if (!sb.files.listings.has(path)) void ensureListing(path).then(renderFilesTree);
  }
  markDirty();
  renderFilesTree();
}

/** Opens a file in the read-only viewer (master-detail). */
export async function openFile(path: string): Promise<void> {
  sb.files.selectedPath = path;
  const detail = sb.files.detailEl;
  if (sb.files.detailTitleEl) {
    sb.files.detailTitleEl.textContent = path;
    sb.files.detailTitleEl.title = path;
  }
  if (detail) detail.hidden = false;
  const body = sb.files.detailBodyEl;
  if (body) {
    body.textContent = "";
    body.appendChild(el("div", "fdim", t("web.files.loading")));
  }
  markDirty();
  renderFilesTree();

  let res: Response;
  try {
    res = await fetch(fileUrl(path));
  } catch {
    showOpenError();
    return;
  }
  if (!res.ok || !body) {
    showOpenError();
    return;
  }
  const mime = res.headers.get("content-type") || "";
  body.textContent = "";
  if (mime.indexOf("text/plain") === 0) renderText(body, path, await res.text());
  else renderMedia(body, path, mime);
}

/** Closes the viewer and clears the selection. */
export function closeFile(): void {
  sb.files.selectedPath = null;
  if (sb.files.detailEl) sb.files.detailEl.hidden = true;
  markDirty();
  renderFilesTree();
}

/** Invalidates expanded listings and re-reads them (watcher/SSE `files`). */
export function sidebarFilesChanged(): void {
  const paths = ["", ...sb.files.expanded];
  paths.forEach((p) => {
    sb.files.listings.delete(p);
    errored.delete(p);
    truncated.delete(p);
  });
  markDirty();
  renderFilesTree();
  const reload = sb.files.selectedPath ? openFile(sb.files.selectedPath) : Promise.resolve();
  void Promise.all([...paths.map(ensureListing), reload]).then(renderFilesTree);
}

function showOpenError(): void {
  const body = sb.files.detailBodyEl;
  if (!body) return;
  body.textContent = "";
  body.appendChild(el("div", "fdim wn", t("web.files.open_failed")));
}

function fileUrl(path: string): string {
  // Same-origin fetch/<img> authenticates via the HttpOnly `mma_web_auth`
  // cookie (set by any prior API request), so no token rides in the URL.
  return "/api/file?path=" + encodeURIComponent(path);
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i + 1).toLowerCase();
}

/** Text files: markdown rendered, everything else in a highlighted <pre>. */
function renderText(body: HTMLElement, path: string, text: string): void {
  const ext = extOf(path);
  if (ext === "md" || ext === "markdown") {
    const wrap = el("div", "fmd");
    renderMarkdown(wrap, text);
    body.appendChild(wrap);
    return;
  }
  const pre = el("pre", "fpre");
  const code = el("code", "fcode");
  code.textContent = text;
  const hl = window.hljs;
  if (hl) {
    try {
      const res2 = hl.getLanguage(ext)
        ? hl.highlight(text, { language: ext, ignoreIllegals: true })
        : hl.highlightAuto(text);
      code.replaceChildren(...nodesFromHtml(res2.value));
    } catch {
      /* подсветка best-effort */
    }
  }
  pre.appendChild(code);
  body.appendChild(pre);
}

/** Binary-but-viewable files: images/audio/video/PDF via native elements. */
function renderMedia(body: HTMLElement, path: string, mime: string): void {
  const src = fileUrl(path);
  if (mime.indexOf("image/") === 0) {
    const img = document.createElement("img");
    img.className = "fimg";
    img.alt = path;
    img.src = src;
    body.appendChild(img);
    return;
  }
  if (mime.indexOf("application/pdf") === 0) {
    const emb = el("embed", "fembed");
    emb.setAttribute("src", src);
    emb.setAttribute("type", "application/pdf");
    body.appendChild(emb);
    return;
  }
  const tag = mime.indexOf("audio/") === 0 ? "audio" : mime.indexOf("video/") === 0 ? "video" : null;
  if (tag) {
    const media = document.createElement(tag);
    media.controls = true;
    media.src = src;
    body.appendChild(media);
    return;
  }
  showOpenError();
}

/** highlight.js output is trusted HTML; import inertly (no `innerHTML`). */
function nodesFromHtml(html: string): Node[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.body.childNodes).map((n) => document.importNode(n, true));
}
