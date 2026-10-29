// Search for the Files tab (C-01): bounded `/api/search` over file names and
// contents, debounced input, results list that opens the existing viewer.
//
// While the query is non-empty the tree is hidden and the results list takes
// its place; clearing the query brings the tree back untouched (it was never
// re-rendered). Name hits carry only `path`; content hits carry `path:line` and
// the matched line (trimmed and already capped by the server). Both reuse
// `openFile(path, line?)`, the same navigation path as the LSP panel — no second
// scroll implementation.
import { api } from "../../api.js";
import { el } from "../../dom.js";
import { t } from "../../i18n.js";
import { sb, type SearchHit } from "../state.js";

interface SearchDeps {
  openFile: (path: string, line?: number) => void;
}

interface SearchPayload {
  results?: SearchHit[];
  truncated?: boolean;
}

const DEBOUNCE_MS = 300;

let deps: SearchDeps = { openFile: () => {} };
let timer: number | null = null;

/** Wires the search field once (`initFiles`); later calls refresh the hook. */
export function initSearch(d: Partial<SearchDeps>): void {
  deps = { ...deps, ...d };
  const input = sb.files.searchEl;
  if (!input) return;
  input.addEventListener("input", () => schedule(input.value));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      cancelPending();
      void runSearch(input.value);
    } else if (ev.key === "Escape" && input.value) {
      ev.preventDefault();
      input.value = "";
      cancelPending();
      void runSearch("");
    }
  });
}

function cancelPending(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

function schedule(raw: string): void {
  cancelPending();
  timer = window.setTimeout(() => {
    timer = null;
    void runSearch(raw);
  }, DEBOUNCE_MS);
}

/** Runs a query (or clears the results for an empty one), guarding races. */
export async function runSearch(raw: string): Promise<void> {
  const f = sb.files;
  const q = raw.trim();
  if (!q) {
    resetSearch();
    return;
  }
  const seq = ++f.searchSeq;
  f.searchQuery = q;
  f.searchLoading = true;
  f.searchError = false;
  f.searchResults = [];
  f.searchTruncated = false;
  renderSearch();
  const r = await api<SearchPayload>("/api/search?q=" + encodeURIComponent(q));
  if (seq !== f.searchSeq) return; // ответ устаревшего запроса
  f.searchLoading = false;
  if (!r.ok || !r.data) {
    f.searchError = true;
  } else {
    f.searchResults = Array.isArray(r.data.results) ? r.data.results : [];
    f.searchTruncated = Boolean(r.data.truncated);
  }
  renderSearch();
}

/** Clears the query/results and brings the tree back (workspace switch, Esc). */
export function resetSearch(): void {
  const f = sb.files;
  f.searchSeq++;
  f.searchQuery = "";
  f.searchResults = [];
  f.searchLoading = false;
  f.searchError = false;
  f.searchTruncated = false;
  if (f.searchEl) f.searchEl.value = "";
  renderSearch();
}

/** Re-renders results/status and toggles tree vs. results (locale switch too). */
export function renderSearch(): void {
  const f = sb.files;
  const box = f.searchResultsEl;
  const active = Boolean(f.searchQuery);
  if (f.treeEl) f.treeEl.hidden = active;
  if (!box) return;
  box.hidden = !active;
  box.textContent = "";
  // A new query must start at the first hit even if the previous result list
  // was scrolled: otherwise the user sees the middle/bottom and may not guess
  // that the list even changed.
  if (active) box.scrollTop = 0;
  if (!active) return;
  if (f.searchLoading) {
    box.appendChild(el("div", "fdim", t("web.files.loading")));
    return;
  }
  if (f.searchError) {
    box.appendChild(el("div", "fdim wn", t("web.files.search_error")));
    return;
  }
  if (f.searchResults.length === 0) {
    box.appendChild(el("div", "fdim", t("web.files.search_no_results")));
    return;
  }
  for (const hit of f.searchResults) box.appendChild(hitRow(hit));
  if (f.searchTruncated) {
    box.appendChild(
      el("div", "fdim wn fsearch-note", t("web.files.search_truncated", { n: f.searchResults.length })),
    );
  }
}

/** One clickable result: `path:line` + line, or just the matched file path. */
function hitRow(hit: SearchHit): HTMLElement {
  const row = el("button", "fsearch-row");
  row.type = "button";
  row.dataset.path = hit.path;
  if (hit.kind === "path") {
    // Name match: open from the top — there is no line to scroll to.
    row.classList.add("fsearch-file");
    row.setAttribute("aria-label", hit.path);
    const path = el("span", "fsearch-path", hit.path);
    path.title = hit.path;
    row.appendChild(path);
    row.addEventListener("click", () => deps.openFile(hit.path));
    return row;
  }
  row.dataset.line = String(hit.line);
  const label = `${hit.path}:${hit.line}`;
  row.setAttribute("aria-label", label);
  const path = el("span", "fsearch-path", label);
  path.title = label;
  row.appendChild(path);
  row.appendChild(el("code", "fsearch-text", hit.text));
  row.addEventListener("click", () => deps.openFile(hit.path, hit.line));
  return row;
}
