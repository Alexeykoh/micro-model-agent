// Per-tab state projection for the app shell: snapshot hydration, the active
// tab's chrome render, and the boot/reconnect refresh. Extracted from `app.ts`
// (file-size rule 6) so the composition root stays a wiring file: no module
// here imports `app.ts`, so the frontend DAG stays acyclic.
import { api } from "./js/api.js";
import { tabs as tabState, session, settings } from "./js/store.js";
import { routeState, storeSnapshot, applyCounters, shouldHydrateAutoOpen } from "./js/state-sync.js";
import type { Dict } from "./js/core/store/types.js";
import {
  showEmptyFeed, renderPlan, renderUsage, renderEnvironment, renderWorkspace, renderSpeed,
  feedHasContent, loadHistory,
} from "./js/feed.js";
import {
  openTab, updateTabName, renderSessionsDropdown, reflectBusy, loadSessions,
  reconcileTabStatuses,
} from "./js/session/tabs.js";
import { renderSelectors, renderSettings, setStaleBar } from "./js/settings.js";
import { setPlan as railPlan } from "./js/rail.js";
import {
  sidebarSessionChanged, sidebarMapState, sidebarMapIndicator, setSessionLoading,
  sidebarLspState, sidebarFilesState, sidebarPluginsState, sidebarFilesChanged,
  sidebarGitChanged,
} from "./js/sidebar.js";
import { setUpdateInfo } from "./js/update-state.js";
import { refreshPauseButton } from "./js/session/pause.js";

// Track the workspace file-change counter: a rise (missed SSE fallback) makes
// the Files tab re-read its expanded directories.
let lastFilesRevision = -1;

// Last seen latest-update version; guards the empty-feed refresh from running
// on every state tick.
let lastUpdLatest = "";

// Renders the active tab's stored snapshot into the sidebar chrome. `session.host`
// mirrors it for the render helpers (plan/usage/env/…), which read it directly.
export function renderActiveState(): void {
  const tab = tabState.tabs.find((x) => x.id === tabState.activeTabId) || null;
  const host = (tab && tab.state) || {};
  session.host = host;
  const sid = host.sessionId || (tab && tab.id) || null;
  session.activeSessionId = sid;
  if (!tabState.tabs.length) showEmptyFeed();
  renderPlan(tab?.livePlan ?? host.plan); // живой план (событие plan) важнее снапшота
  railPlan(session.busy && host ? (tab?.livePlan ?? host.plan) : null);
  renderUsage(host); renderSpeed(host);
  // Late provider auto-detect may change the effective window after boot — the
  // snapshot carries it so the topbar follows without a config re-fetch.
  if (typeof host.contextWindow === "number" && settings.config &&
      settings.config.contextWindow !== host.contextWindow) {
    settings.config.contextWindow = host.contextWindow;
    renderSelectors();
  }
  renderEnvironment(host);
  sidebarMapState(host);
  sidebarMapIndicator(host);
  sidebarLspState();
  sidebarFilesState(host);
  sidebarPluginsState();
  const rev = typeof host.filesRevision === "number" ? host.filesRevision : undefined;
  if (rev !== undefined && rev !== lastFilesRevision) {
    const first = lastFilesRevision === -1;
    lastFilesRevision = rev;
    if (!first && rev > 0) {
      sidebarFilesChanged();
      // Git working-tree changed too: re-read the Changes tab list (was a
      // dead export — nothing called it, so the tab went stale after edits).
      sidebarGitChanged();
    }
  }
  sidebarSessionChanged(sid);
  // Пауза — поле проекции `state`: перерисовать кнопку на каждый снимок
  // (переключение вкладок обновляет её через renderTabstrip).
  refreshPauseButton();
  renderWorkspace(host);
  // Update fact is global (not per-tab): publish it to the chrome readers and
  // badge the settings gear; refresh an empty feed so the update card appears.
  const updLatest = host.updateAvailable?.latest ?? "";
  setUpdateInfo(host.updateAvailable || null);
  const gear = document.getElementById("openSettings");
  if (gear) gear.classList.toggle("has-upd", !!host.updateAvailable);
  if (updLatest !== lastUpdLatest) {
    lastUpdLatest = updLatest;
    // Settings render before the first state arrives; refresh so the General
    // "about" row picks up the dot + update button.
    renderSettings();
    // Only the TOP-LEVEL empty view (no open tab) may be rebuilt here. A tab's
    // feed owns its own `.empty`; matching it re-rendered `#msgs` and detached
    // the live tab feed, which froze the chat while an update card was shown.
    if (document.querySelector("#msgs > .empty")) showEmptyFeed();
  }
  renderSessionsDropdown();
  setSessionLoading(false);
  setStaleBar(!!host.i18nStale);
}

// Applies an SSE `state` payload to the per-tab store; re-renders when it
// targets the active tab (or is global). Counters always refresh tab badges.
export function applyState(d: Dict): void {
  const renderActive = routeState(d);
  reflectBusy();
  reconcileTabStatuses();
  if (d.state && typeof d.state.sessionId === "string") {
    updateTabName(d.state.sessionId, d.state.sessionName);
  }
  if (renderActive) renderActiveState();
}

async function fetchState(sessionId: string | null): Promise<Dict | null> {
  const url = sessionId ? "/api/state?session=" + encodeURIComponent(sessionId) : "/api/state";
  const r = await api<{ state?: Dict; busy?: unknown }>(url);
  return r.ok && r.data ? r.data : null;
}

// Renders a tab from its cached snapshot; fetches once when it has none.
export async function ensureTabState(id: string): Promise<void> {
  const tab = tabState.tabs.find((x) => x.id === id);
  if (!tab) return;
  if (tab.state) {
    if (tabState.activeTabId === id) renderActiveState();
    return;
  }
  const data = await fetchState(id);
  if (!data) return;
  storeSnapshot(data.state);
  if (tabState.activeTabId !== id) return;
  applyCounters(data);
  renderActiveState();
}

// Boot/reconnect: refresh the active tab (auto-opening the server-active
// session on first load). Steady-state updates arrive via SSE `state`.
export async function refresh(): Promise<void> {
  const sid = tabState.activeTabId;
  const data = await fetchState(sid);
  if (!data) return;
  // Guard: a switch during the fetch must not clobber the new tab.
  if (tabState.activeTabId !== sid) return;
  const snapshot = data.state;
  if (!sid && snapshot && snapshot.sessionId &&
      !tabState.tabs.some((x) => x.id === snapshot.sessionId)) {
    // An existing session (has messages) must hydrate its transcript — opening
    // it as "live" left the feed empty (no first message / earlier turns) until
    // new SSE; a brand-new session stays live (nothing to fetch).
    const hasHistory = shouldHydrateAutoOpen(session.sessions, snapshot.sessionId);
    openTab(snapshot.sessionId, snapshot.sessionName || String(snapshot.sessionId), "session", hasHistory);
  }
  storeSnapshot(snapshot);
  applyCounters(data);
  renderActiveState();
}

// SSE reconnect: drop every cached snapshot so the next render is fresh, then
// refetch the active tab, the session list and an empty transcript.
export function resyncAfterReconnect(): void {
  for (const tab of tabState.tabs) {
    if (tab.kind !== "session") continue;
    tab.state = null;
    void ensureTabState(tab.id);
  }
  void refresh();
  void loadSessions();
  const tab = tabState.tabs.find((x) => x.id === tabState.activeTabId);
  if (tab && tab.kind === "session" && !feedHasContent(tab.feed)) {
    tab.historyLoaded = false;
    void loadHistory(tab);
  }
}
