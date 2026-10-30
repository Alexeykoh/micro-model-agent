// Shared sidebar context for `mma web`: DOM refs + per-session Trace/LSP state.
// Split out of `sidebar.js` so `core`/`trace`/`map`/`lsp` submodules share one
// mutable context object instead of a closure over module-level `let`s.
import type { Dict } from "../core/store/types.js";

export const TAB_KEY = "mma-sidebar-tab";
// Display order of the tabs — and, because `Alt+1..8` indexes this array, the
// order of the hotkeys too. Usage frequency first (what you look at while a
// turn runs), diagnostics in the middle, the project-wide map last: it is the
// one tab you open deliberately rather than by reflex.
export const TABS = ["session", "files", "lsp", "trace", "subagents", "plugins", "mcp", "map"];
// Иконки вкладок подобраны так, чтобы читаться в 17px: плотные lucide-иконки
// (складная карта, стетоскоп, пазл) на таком размере сливаются в пятно.
export const ICON_NAME: Record<string, string> = {
  session: "list-checks",
  map: "layout-grid",
  trace: "activity",
  lsp: "code",
  files: "folder-tree",
  subagents: "bot",
  plugins: "plug",
  mcp: "server",
};
export const TRACE_CAP = 500;
export const MAX_OUTPUT_CHARS = 20000;
/** Порог, ниже которого простой в гейтах (`gate_timing`) не заслуживает строки. */
export const TRACE_GATE_NOTICE_MS = 3000;

// One Trace row. Fields are loosely typed on purpose — the entry is built from
// heterogeneous SSE/log payloads (`sidebarTraceEvent`/`appendLogEntry`).
export type TraceEntry = Dict;

/** Одна запись дерева Files (ответ `GET /api/files`). */
export interface FileEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
}

/** Одно совпадение поиска (ответ `GET /api/search`): имя/путь или строка. */
export type SearchHit =
  { kind: "path"; path: string } | { kind: "content"; path: string; line: number; text: string };

/** Состояние вкладки Files: DOM-узлы, раскрытые папки, кэш листингов. */
export interface FilesView {
  /** Левая колонка: панель управления + дерево. */
  sideEl: HTMLElement | null;
  /** Перетаскиваемая граница дерева и просмотра. */
  splitterEl: HTMLElement | null;
  treeEl: HTMLElement | null;
  detailEl: HTMLElement | null;
  /** Хлебные крошки пути открытого файла. */
  crumbEl: HTMLElement | null;
  backEl: HTMLButtonElement | null;
  fwdEl: HTMLButtonElement | null;
  wideEl: HTMLButtonElement | null;
  collapseAllEl: HTMLButtonElement | null;
  expandAllEl: HTMLButtonElement | null;
  refreshEl: HTMLButtonElement | null;
  detailBodyEl: HTMLElement | null;
  detailAttachEl: HTMLButtonElement | null;
  /** Раскрытые каталоги (ключ — относительный posix-путь; "" — корень). */
  expanded: Set<string>;
  /** Кэш листинга по относительному пути. */
  listings: Map<string, FileEntry[]>;
  /** Каталоги, которые сервер ответил усечёнными (строка-предупреждение). */
  truncated: Set<string>;
  /** Каталоги, которые не удалось загрузить (строка-ошибка). */
  errored: Set<string>;
  /** Путь workspace (`""` — нет). Смена пути сбрасывает дерево и историю. */
  workspace: string;
  /** Открытый в просмотрщике файл (relative path) или null. */
  selectedPath: string | null;
  /** Курсор клавиатурной навигации по дереву (relative path) или null. */
  cursor: string | null;
  /** История просмотра: стек путей + индекс текущего (back/forward). */
  history: string[];
  histIndex: number;
  /** Идёт ли массовое «развернуть всё» (кнопки блокируются). */
  expanding: boolean;
  /** Развёртка упёрлась в кап — показать строку-предупреждение. */
  expandCapped: boolean;
  /** Показывать все сегменты пути (крошки свёрнуты в `…` по умолчанию). */
  crumbsOpen: boolean;
  /** Поле поиска по имени и содержимому (C-01). */
  searchEl: HTMLInputElement | null;
  /** Список совпадений вместо дерева (пока запрос не пуст). */
  searchResultsEl: HTMLElement | null;
  /** Последний запрос; пустой — дерево видно, результаты скрыты. */
  searchQuery: string;
  searchResults: SearchHit[];
  searchLoading: boolean;
  searchError: boolean;
  searchTruncated: boolean;
  /** Счётчик запросов: ответ старого запроса не должен перебить новый. */
  searchSeq: number;
}

/** Состояние вкладки Plugins: DOM-узел, записи реестра, отказы загрузки. */
export interface PluginsView {
  bodyEl: HTMLElement | null;
  /** Плоские записи `PluginRecord[]` из `GET /api/plugins`. */
  records: Array<Record<string, any>>;
  /** Не загрузившиеся плагины (раньше просто исчезали). */
  failures: Array<Record<string, any>>;
  loaded: boolean;
  unavailable: boolean;
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
  reasonEntry: TraceEntry | null;
  lspDiag: Dict | null;
  lspFlags: { enabled: boolean; offline: boolean } | null;
  lspProbing: boolean;
  lspLoaded: boolean;
  /** Когда последняя диагностика LSP завершилась (ms) — вкладка показывает «проверено …». */
  lspCheckedAt: number | null;
  lspUnavailable: boolean;
  reindexing: boolean;
  postResolved: boolean;
  reindexError: boolean;
  files: FilesView;
  plugins: PluginsView;
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
  reasonEntry: null, // current reasoning row (updated in place)
  lspDiag: null, // last LspDiagnosis (web.sidebar LSP tab)
  lspFlags: null, // { enabled, offline } global switches (config.lsp.*)
  lspProbing: false, // a diagnosis is running right now
  lspLoaded: false, // cache was fetched at least once
  lspCheckedAt: null, // finished-at timestamp of the last diagnosis
  lspUnavailable: false, // the server has no LSP module wired
  reindexing: false, // client spinner until a fresh snapshot
  postResolved: false, // POST returned; next snapshot clears the spinner
  reindexError: false, // last POST failed
  files: {
    sideEl: null,
    splitterEl: null,
    treeEl: null,
    detailEl: null,
    crumbEl: null,
    backEl: null,
    fwdEl: null,
    wideEl: null,
    collapseAllEl: null,
    expandAllEl: null,
    refreshEl: null,
    detailBodyEl: null,
    detailAttachEl: null,
    expanded: new Set(), // "" (root) is expanded implicitly in render
    listings: new Map(),
    truncated: new Set(),
    errored: new Set(),
    workspace: "",
    selectedPath: null,
    cursor: null,
    history: [],
    histIndex: -1,
    expanding: false,
    expandCapped: false,
    crumbsOpen: false,
    searchEl: null,
    searchResultsEl: null,
    searchQuery: "",
    searchResults: [],
    searchLoading: false,
    searchError: false,
    searchTruncated: false,
    searchSeq: 0,
  },
  plugins: {
    bodyEl: null,
    records: [],
    failures: [],
    loaded: false,
    unavailable: false,
  },
};

export function paneEl(id: string): HTMLElement | null {
  return document.getElementById("pane-" + id);
}

/**
 * Breakpoints, shared with `styles.css`:
 * - `NARROW` — the sidebar no longer fits beside the chat and becomes an
 *   overlay drawer (see `sidebar/drawer.ts`).
 * - `PHONE` — phone chrome; the session sub-bar appears and Trace is dropped
 *   (its list + 340px detail pane do not fit).
 */
export const NARROW_MQ = "(max-width: 1024px)";
export const PHONE_MQ = "(max-width: 760px)";

function mq(query: string): boolean {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia(query).matches
    : false;
}

/** True when the sidebar is a drawer rather than a column next to the chat. */
export function mqNarrow(): boolean {
  return mq(NARROW_MQ);
}

/** True on phone-sized viewports (session sub-bar, no Trace tab). */
export function mqMobile(): boolean {
  return mq(PHONE_MQ);
}

export function readStored(): string | null {
  try {
    return localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

export function storeTab(id: string): void {
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    /* private mode */
  }
}
