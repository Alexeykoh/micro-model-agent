// Shared sidebar context for `mma web`: DOM refs + per-session Trace/LSP state.
// Split out of `sidebar.js` so `core`/`trace`/`map`/`lsp` submodules share one
// mutable context object instead of a closure over module-level `let`s.
import type { Dict } from "../core/store/types.js";

export const TAB_KEY = "mma-sidebar-tab";
export const TABS = ["session", "map", "trace", "lsp", "files"];
export const ICON_NAME: Record<string, string> = {
  session: "list-checks",
  map: "map",
  trace: "activity",
  lsp: "stethoscope",
  files: "folder-tree",
};
export const TRACE_CAP = 500;
export const MAX_OUTPUT_CHARS = 20000;

// One Trace row. Fields are loosely typed on purpose — the entry is built from
// heterogeneous SSE/log payloads (`sidebarTraceEvent`/`appendLogEntry`).
export type TraceEntry = Dict;

/** Одна запись дерева Files (ответ `GET /api/files`). */
export interface FileEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
}

/** Состояние вкладки Files: DOM-узлы, раскрытые папки, кэш листингов. */
export interface FilesView {
  treeEl: HTMLElement | null;
  detailEl: HTMLElement | null;
  detailTitleEl: HTMLElement | null;
  detailBodyEl: HTMLElement | null;
  detailAttachEl: HTMLElement | null;
  /** Раскрытые каталоги (ключ — относительный posix-путь; "" — корень). */
  expanded: Set<string>;
  /** Кэш листинга по относительному пути. */
  listings: Map<string, FileEntry[]>;
  /** Открытый в просмотрщике файл (relative path) или null. */
  selectedPath: string | null;
}

export interface SidebarState {
  el: HTMLElement | null;
  nameEl: HTMLElement | null;
  nameTextEl: HTMLElement | null;
  mapEl: HTMLElement | null;
  listEl: HTMLElement | null;
  detailEl: HTMLElement | null;
  detailGlyph: HTMLElement | null;
  detailTitle: HTMLElement | null;
  detailBody: HTMLElement | null;
  detailClose: HTMLElement | null;
  lspEl: HTMLElement | null;
  active: string;
  trace: TraceEntry[];
  selected: number | null;
  turn: number;
  seq: number;
  logCursor: string | null;
  logPulling: boolean;
  nodeById: Map<number, HTMLElement>;
  callIndex: Map<string | number, TraceEntry>;
  headerByTurn: Map<number, HTMLElement>;
  textEntry: TraceEntry | null;
  lspDiag: Dict | null;
  lspFlags: { enabled: boolean; offline: boolean } | null;
  lspProbing: boolean;
  lspLoaded: boolean;
  lspUnavailable: boolean;
  reindexing: boolean;
  postResolved: boolean;
  reindexError: boolean;
  files: FilesView;
}

export const sb: SidebarState = {
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
  files: {
    treeEl: null,
    detailEl: null,
    detailTitleEl: null,
    detailBodyEl: null,
    detailAttachEl: null,
    expanded: new Set(), // "" (root) is expanded implicitly in render
    listings: new Map(),
    selectedPath: null,
  },
};

export function paneEl(id: string): HTMLElement | null {
  return document.getElementById("pane-" + id);
}

export function mqMobile(): boolean {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 760px)").matches
    : false;
}

export function readStored(): string | null {
  try { return localStorage.getItem(TAB_KEY); } catch { return null; }
}

export function storeTab(id: string): void {
  try { localStorage.setItem(TAB_KEY, id); } catch { /* private mode */ }
}
