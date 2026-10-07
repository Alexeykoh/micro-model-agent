// Sessions dropdown: list/filter, open session, delete with confirmation.
// Extracted from `tabs.js`. The tab operations it needs (`openTab`/`closeTab`/
// `loadSessions`/`newChatTab`) arrive via `initSessionsMenu`, so this module
// never imports the tab hub (no cycle).
import { el, icon } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { session } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { relTime, matchesQuery } from "../format.js";
import { openConfirm } from "../dialog.js";
import { setSessOpen, setSessionCloseHook } from "../core/menus.js";

interface SessionsMenuDeps {
  openTab: (id: string, name?: string, kind?: string, server?: boolean) => void;
  closeTab: (id: string) => void;
  loadSessions: () => void | Promise<void>;
  newChatTab: () => void | Promise<void>;
}

let deps: SessionsMenuDeps = {
  openTab: () => {},
  closeTab: () => {},
  loadSessions: async () => {},
  newChatTab: async () => {},
};

/** Tab hub injects its operations; keeps the module DAG acyclic. */
export function initSessionsMenu(d: Partial<SessionsMenuDeps>): void {
  deps = { ...deps, ...d };
}

// biome-ignore lint/suspicious/noExplicitAny: opaque timer handle.
let sessionsErrTimer: any = null;

// Live filter text of the sessions dropdown. Module-level so `sessions`-event
// and state re-renders never wipe an in-progress query: the
// `<input id="sessSearch">` itself lives statically in `index.html` and only
// the row lists are redrawn.
let sessQuery = "";
let sessSearchWired = false;

// One-time wiring for the static `#sessSearch` input: placeholder follows the
// locale on every render, listeners attach once. Returns the input or null.
function ensureSessSearch(): HTMLInputElement | null {
  const search = document.getElementById("sessSearch") as HTMLInputElement | null;
  if (!search) return null;
  search.placeholder = t("web.sessions.search");
  search.setAttribute("aria-label", t("web.sessions.search"));
  if (!sessSearchWired) {
    sessSearchWired = true;
    search.addEventListener("click", (e) => e.stopPropagation());
    search.addEventListener("input", () => {
      sessQuery = search.value;
      renderSessionsDropdown();
      // Re-render must not steal the caret: the input node itself survives
      // (only the lists redraw), but re-query it to be safe.
      const again = document.getElementById("sessSearch");
      if (again && document.activeElement !== again) again.focus();
    });
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        if (search.value) {
          e.preventDefault();
          search.value = "";
          sessQuery = "";
          renderSessionsDropdown();
          search.focus();
        } else {
          setSessOpen(false);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const first = document.querySelector<HTMLElement>("#sessActiveList .si-row .dd-row-main, #sessRecentList .si-row .dd-row-main");
        if (first) first.focus();
      }
    });
  }
  return search;
}

export function renderSessionsDropdown(): void {
  ensureSessSearch();
  const activeList = document.getElementById("sessActiveList");
  const recentList = document.getElementById("sessRecentList");
  const activeHeader = document.getElementById("sessActiveHeader");
  const recentHeader = document.getElementById("sessRecentHeader");
  if (!activeList || !recentList) return;
  activeList.textContent = "";
  recentList.textContent = "";
  const q = sessQuery.trim();
  const activeId = session.activeSessionId;
  const sorted = session.sessions.slice().sort((a: Dict, b: Dict) => {
    const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bt - at;
  }).filter((s: Dict) => matchesQuery((s.name || "") + " " + String(s.id || ""), q));
  let activePlaced = false;
  let recentPlaced = false;
  sorted.forEach((s: Dict) => {
    const isActive = s.id === activeId;
    const row = sessionRow(s, isActive);
    if (isActive && !activePlaced) {
      activeList.appendChild(row);
      activePlaced = true;
    } else {
      recentList.appendChild(row);
      recentPlaced = true;
    }
  });
  if (q) {
    // Filtered view: empty sections hide with their headers; zero hits total
    // show a single no-matches row instead of the unfiltered placeholders.
    if (activeHeader) activeHeader.hidden = !activePlaced;
    if (recentHeader) recentHeader.hidden = !recentPlaced;
    if (!activePlaced && !recentPlaced) {
      if (recentHeader) recentHeader.hidden = true;
      recentList.appendChild(el("div", "si dim", t("web.settings.no_matches")));
    }
  } else {
    if (activeHeader) activeHeader.hidden = false;
    if (recentHeader) recentHeader.hidden = false;
    if (!activePlaced) {
      activeList.appendChild(el("div", "si", t("web.sessions.none_active")));
    }
    if (!recentPlaced) {
      recentList.appendChild(el("div", "si", t("web.sessions.none")));
    }
  }
  if (session.sessionsError) {
    recentList.appendChild(el("div", "dd-err", session.sessionsError));
  }
}

function sessionRow(s: Dict, isActive: boolean): HTMLElement {
  const row = el("div", "si si-row" + (isActive ? " on" : ""));
  const name = s.name || String(s.id);
  const main = el("button", "dd-row-main");
  main.type = "button";
  main.setAttribute("aria-label", name);
  main.appendChild(el("span", "id", String(s.id)));
  main.appendChild(el("span", "name", name));
  main.appendChild(el("span", "meta", relTime(s.updatedAt)));
  main.addEventListener("click", () => {
    setSessOpen(false);
    deps.openTab(s.id, name, "session", true);
  });
  row.appendChild(main);
  // The active session can't be removed server-side (409), so it has no
  // delete control at all.
  if (!isActive) {
    const del = el("button", "del-btn");
    del.type = "button";
    del.appendChild(icon("trash"));
    const label = t("web.sessions.delete");
    del.title = label;
    del.setAttribute("aria-label", label + ": " + name);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteSession(s.id, name);
    });
    row.appendChild(del);
  }
  return row;
}

// --- session delete: confirmation dialog --------------------------------
function confirmDeleteSession(id: string, name: string): void {
  openConfirm({
    title: t("web.sessions.confirm_title"),
    body: t("web.sessions.confirm_body", { name }),
    onAccept: () => void deleteSession(id),
  });
}

function showSessionsError(msg: string): void {
  session.sessionsError = msg;
  renderSessionsDropdown();
  if (sessionsErrTimer) clearTimeout(sessionsErrTimer);
  sessionsErrTimer = setTimeout(() => {
    session.sessionsError = null;
    renderSessionsDropdown();
  }, 4500);
}

async function deleteSession(id: string): Promise<void> {
  const r = await api<Dict>("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" });
  if (!r.ok) {
    const code = r.data && typeof r.data.error === "string" ? r.data.error : "";
    showSessionsError(
      code === "active_session" || code === "session_busy"
        ? t("web.sessions.active_guard")
        : t("web.sessions.delete_failed"),
    );
  } else {
    session.sessionsError = null;
    // Удалённая сессия не должна оставаться открытой вкладкой с мёртвым id
    // (иначе — activate/history 404, сайдбар не следует, "история недоступна").
    deps.closeTab(id);
  }
  await deps.loadSessions();
}

const sessDD = document.getElementById("sessDD");
const sessBtn = document.getElementById("sessBtn");

// The open/close chrome lives in the leaf `core/menus.js`; register the filter
// cleanup it must run on close (menus must not depend on `tabs` upward).
setSessionCloseHook(() => {
  if (!sessQuery) return;
  // Closing wipes the filter so the next opening starts from the full list.
  sessQuery = "";
  const search = document.getElementById("sessSearch") as HTMLInputElement | null;
  if (search && search.value) {
    search.value = "";
    renderSessionsDropdown();
  }
});

function focusSessSearch(): void {
  setTimeout(() => {
    const search = document.getElementById("sessSearch") as HTMLInputElement | null;
    if (search) search.focus();
  }, 0);
}

/** Toggle the dropdown (shared by the topbar and mobile sub-header buttons). */
export function openSessionsMenu(): void {
  document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
  if (!sessDD) return;
  const willOpen = !sessDD.classList.contains("open");
  setSessOpen(willOpen);
  if (willOpen) focusSessSearch();
}

if (sessBtn) {
  sessBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openSessionsMenu();
  });
}

const sessNewBtn = document.getElementById("sessNew");
if (sessNewBtn) {
  sessNewBtn.addEventListener("click", () => {
    void deps.newChatTab();
    setSessOpen(false);
  });
}
const sessRefreshBtn = document.getElementById("sessRefresh");
if (sessRefreshBtn) {
  sessRefreshBtn.addEventListener("click", () => {
    void deps.loadSessions();
  });
}
