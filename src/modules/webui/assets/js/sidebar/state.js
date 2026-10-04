// Shared sidebar context for `mma web`: DOM refs + per-session Trace/LSP state.
// Split out of `sidebar.js` so `core`/`trace`/`map`/`lsp` submodules share one
// mutable context object instead of a closure over module-level `let`s.
export const TAB_KEY = "mma-sidebar-tab";
export const TABS = ["session", "map", "trace", "lsp"];
export const ICON_NAME = { session: "list-checks", map: "map", trace: "activity", lsp: "stethoscope" };
export const TRACE_CAP = 500;
export const MAX_OUTPUT_CHARS = 20000;

export const sb = {
  el: null,
  nameEl: null,
  nameTextEl: null,
  mapEl: null,
  listEl: null,
  detailEl: null,
  detailGlyph: null,
  detailTitle: null,
  detailBody: null,
  detailClose: null,
  lspEl: null,
  active: "session",
  // { id, kind, ts, name, args, output, success, durationMs, phase, text, steps, currentIndex }
  trace: [],
  selected: null, // trace id
  turn: 0,
  seq: 0,
  logCursor: null, // max session-log ts already pulled (supplement fetch)
  logPulling: false,
  nodeById: new Map(), // entry id → row node
  callIndex: new Map(), // toolCallId → entry
  headerByTurn: new Map(), // turn → header node
  textEntry: null, // current text row (updated in place)
  lspDiag: null, // last LspDiagnosis (web.sidebar LSP tab)
  lspFlags: null, // { enabled, offline } global switches (config.lsp.*)
  lspProbing: false, // a diagnosis is running right now
  lspLoaded: false, // cache was fetched at least once
  lspUnavailable: false, // the server has no LSP module wired
  reindexing: false, // client spinner until a fresh snapshot
  postResolved: false, // POST returned; next snapshot clears the spinner
  reindexError: false, // last POST failed
};

export function paneEl(id) {
  return document.getElementById("pane-" + id);
}

export function mqMobile() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 760px)").matches
    : false;
}

export function readStored() {
  try { return localStorage.getItem(TAB_KEY); } catch { return null; }
}

export function storeTab(id) {
  try { localStorage.setItem(TAB_KEY, id); } catch { /* private mode */ }
}
