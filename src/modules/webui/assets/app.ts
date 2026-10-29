import { msgs, inp, connStatus, setIcon, icon } from "./js/dom.js";
import { api, token } from "./js/api.js";
import { I18N, t, loadI18n } from "./js/i18n.js";
import { tabs as tabState, session, settings, hooks } from "./js/store.js";
import { routeState, mergeUsage, storeSnapshot, applyCounters, shouldHydrateAutoOpen } from "./js/state-sync.js";
import type { Dict } from "./js/core/store/types.js";
import {
  onText, onReasoning, onMeta, onPhase, onToolStart, onToolEnd,
  onTurnEnd, onErrorEvent, onCommandOutput, onLog, onPlan, onQuestion,
  onRetract,
  showEmptyFeed, renderPlan, renderUsage, renderEnvironment, renderWorkspace,
  feedHasContent, loadHistory,
} from "./js/feed.js";
import {
  openTab, updateTabName, renderSessionsDropdown, reflectBusy, loadSessions,
  loadCommands, setTabStatus, reconcileTabStatuses,
} from "./js/session/tabs.js";
import { restoreTabs } from "./js/session/restore-tabs.js";
import {
  renderSelectors, renderSettings, loadConfig, loadModels, loadProviders,
  loadMemory, loadSkills, loadPlugins, applyTheme, currentTheme, applyUiTheme, currentUiTheme, applyFontSize, setConnStatus, setStaleBar,
} from "./js/settings.js";
import {
  initRail, setPlan as railPlan, railEvent, applyRailI18n,
} from "./js/rail.js";
import {
  initSidebar, sidebarSessionChanged, sidebarMapState,
  sidebarTraceEvent, sidebarTurnEnd, sidebarBusy, sidebarMapIndicator,
  sidebarPullLog, sidebarSessionId, setSessionLoading,
  sidebarLspState, sidebarLspEvent,
  applySidebarI18n,
  initFiles, sidebarFilesState, sidebarFilesChanged,
  sidebarPluginsState, sidebarPluginsEvent, initSidebarDrawer,
  sidebarSubagentEvent, sidebarMcpEvent,
  openFilesTabFor,
} from "./js/sidebar.js";
import { insertIntoDraft } from "./js/session/composer.js";
import { drainQueuedTurn } from "./js/session/queue.js";
import { initCursor, createFace, setFaceState, loaderStateFor, setGreetResolver } from "./js/loader.js";
import type { FaceState } from "./js/loader.js";
import { setUpdateInfo } from "./js/update-state.js";
import { applyUpdateEvent } from "./js/update-ui.js";
import { initSubagentView, onSubagentEvent } from "./js/feed/subagent.js";

declare global {
  interface Window {
    MmaSetup?: { maybeOpen: () => Promise<boolean> };
  }
}

// Persistent face in the composer's selectors row: always reflects the current
// agent state, falling back to the idle (cursor-following) face between turns.
let composerFace: HTMLElement | null = null;
let composerToken = 0;
// Last seen latest-update version; guards the empty-feed refresh from running
// on every state tick.
let lastUpdLatest = "";

function faceEvent(state: FaceState): void {
  composerToken++;
  setFaceState(composerFace, state);
}

function initComposerFace(): void {
  const host = document.getElementById("composerFace");
  if (!host) return;
  composerFace = createFace("idle", "sm");
  host.replaceChildren(composerFace);
}

// App-shell hooks for the update chrome (`js/update-ui.ts`): MMART reaction,
// settle-back-to-idle, and a post-install chrome refresh.
const updateHooks = {
  face: (state: FaceState) => faceEvent(state),
  settleIdle: () => {
    const token = composerToken;
    window.setTimeout(() => { if (token === composerToken) setFaceState(composerFace, "idle"); }, 4000);
  },
  refreshChrome: () => {
    renderSettings();
    if (document.querySelector("#msgs > .empty")) showEmptyFeed();
  },
};

document.querySelectorAll<HTMLElement>("[data-collapse]").forEach((head) => {
  const initArrow = head.querySelector(".arrow");
  if (initArrow) {
    initArrow.textContent = "";
    initArrow.appendChild(icon("chevron-down"));
  }
  head.addEventListener("click", () => {
    const body = head.nextElementSibling;
    if (!body) return;
    const collapsed = body.classList.toggle("collapsed");
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const arrow = head.querySelector(".arrow");
    if (arrow) {
      arrow.textContent = "";
      arrow.appendChild(icon(collapsed ? "chevron-right" : "chevron-down"));
    }
  });
});

// Track the workspace file-change counter: a rise (missed SSE fallback) makes
// the Files tab re-read its expanded directories.
let lastFilesRevision = -1;

// Renders the active tab's stored snapshot into the sidebar chrome. `session.host`
// mirrors it for the render helpers (plan/usage/env/…), which read it directly.
function renderActiveState(): void {
  const tab = tabState.tabs.find((x) => x.id === tabState.activeTabId) || null;
  const host = (tab && tab.state) || {};
  session.host = host;
  const sid = host.sessionId || (tab && tab.id) || null;
  session.activeSessionId = sid;
  if (!tabState.tabs.length) showEmptyFeed();
  renderPlan(tab?.livePlan ?? host.plan); // живой план (событие plan) важнее снапшота
  railPlan(session.busy && host ? (tab?.livePlan ?? host.plan) : null);
  renderUsage(host);
  // Late provider auto-detect may change the effective window after boot —
  // the snapshot carries it so the topbar follows without a config re-fetch.
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
    if (!first && rev > 0) sidebarFilesChanged();
  }
  sidebarSessionChanged(sid);
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
function applyState(d: Dict): void {
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
async function ensureTabState(id: string): Promise<void> {
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
async function refresh(): Promise<void> {
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

// Lets `tabs.js` render a switched-to tab (cached snapshot or one REST fetch)
// without importing app.
hooks.ensureTabState = ensureTabState;
// Lets `tabs.js` reset the sidebar chrome when the last tab closes.
hooks.renderActive = renderActiveState;
hooks.openFileInTree = (p) => { void openFilesTabFor(p); };
hooks.openFileAtLine = (p, line) => { void openFilesTabFor(p, line); };
hooks.showFilesTab = () => { void openFilesTabFor(""); };

function resyncAfterReconnect(): void {
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

// One live EventSource for the whole browser window: the server delivers every
// session's events, and each tab routes them client-side (`feedForEvent` by
// `sessionId`). A single stream keeps ALL open tabs (background included)
// streaming live — no per-tab reconnect.
function connectSSE(): void {
  const sseUrl = "/events" + (token ? "?token=" + encodeURIComponent(token) : "");
  const es = new EventSource(sseUrl);
  let dropped = false;
  es.onopen = () => {
    if (!dropped) return;
    dropped = false;
    setConnStatus(false);
    resyncAfterReconnect();
  };
  es.onerror = (e) => {
    // A server-sent `event: error` also lands here but carries `data`; only a
    // real transport drop has none. Don't flag a live stream as disconnected.
    if (e && typeof (e as MessageEvent).data === "string") return;
    dropped = true;
    setConnStatus(true);
  };
  const parse = (e: MessageEvent): Dict | null => {
    try {
      return JSON.parse(e.data) as Dict;
    } catch {
      return null;
    }
  };
  // Sidebar Trace follows its own session: drop events stamped with a different
  // sessionId (background runners). Events without one are global/legacy.
  const sidebarOwns = (d: Dict) => !d.sessionId || d.sessionId === sidebarSessionId();
// SSE event → feed handler table. `command`/`state`/`error` need envelope
// checks and stay bespoke below; everything else is `parse → null-guard → call`.
const handlers: Array<[string, (d: Dict) => void]> = [
  ["text", (d) => onText(d.chunk || "", d.sessionId)],
  ["meta", (d) => onMeta(d.chunk || "", d.sessionId, d.kind)],
  ["reasoning", (d) => onReasoning(d.chunk || "", d.sessionId, {
    level: typeof d.level === "string" ? d.level : undefined,
    source: typeof d.source === "string" ? d.source : undefined,
  })],
  ["phase", (d) => onPhase(d.phase, d.sessionId)],
  ["tool_start", onToolStart],
  ["tool_end", onToolEnd],
  ["plan", onPlan],
  ["question", onQuestion],
  ["turn_end", (d) => { onTurnEnd(d); drainQueuedTurn(d.sessionId); if (sidebarOwns(d)) { sidebarTurnEnd(d.turnSeq); sidebarBusy(false); void sidebarPullLog(); } }],
  ["log", onLog],
  ["retract", (d) => onRetract(d.reason || "", d.sessionId)],
  ["subagent", (d) => { onSubagentEvent(d); sidebarSubagentEvent(); }],
];
for (const [event, fn] of handlers) {
  es.addEventListener(event, (e) => {
    const d = parse(e);
    if (d) fn(d);
  });
}
// Activity rail: its own listeners — feed handlers stay untouched.
for (const ev of ["tool_start", "tool_end", "text", "plan"]) {
  es.addEventListener(ev, (e) => {
    const d = parse(e);
    if (!d) return;
    if (ev === "plan") railPlan(d);
    else railEvent(ev, d.name);
  });
}
// Composer face: one persistent mascot that always reflects the live state.
const faceTypes: Array<[string, "tool_start" | "tool_end" | "text" | "question" | "error"]> = [
  ["tool_start", "tool_start"], ["tool_end", "tool_end"], ["text", "text"],
  ["question", "question"], ["error", "error"],
];
for (const [ev, type] of faceTypes) {
  es.addEventListener(ev, (e) => {
    const d = parse(e);
    if (!d) return;
    faceEvent(
      loaderStateFor({
        type,
        name: typeof d.name === "string" ? d.name : "",
        success: d.success !== false,
        // Нужен только для tool_end: по выводу маскот ловит LSP-реакцию.
        ...(type === "tool_end" && typeof d.output === "string" ? { output: d.output } : {}),
      }),
    );
  });
}
es.addEventListener("phase", (e) => {
  const d = parse(e);
  const phase = d && typeof d.phase === "string" ? d.phase : "";
  faceEvent(phase === "composing" ? "type" : phase === "tool" ? "run" : "think");
});
es.addEventListener("reasoning", () => faceEvent("think"));
es.addEventListener("plan", () => faceEvent("plan"));
es.addEventListener("turn_end", (e) => {
  const d = parse(e);
  // An interrupted turn (`success:false, interrupted:true`) is a user stop, not
  // a failure — settle the face to "done", never "error".
  faceEvent(d && d.success === false && !d.interrupted ? "error" : "done");
  const token = composerToken;
  window.setTimeout(() => { if (token === composerToken) setFaceState(composerFace, "idle"); }, 1500);
});
// Remaining agent-facing SSE: a retracted draft reads as an error, re-indexing
// as workspace search, first-run completion as done. Background broadcasts
// (`usage`/`state`/`config`/`files`/`sessions`/`plugins`/`log`) deliberately
// carry no `faceEvent` — they are not agent activity and must not move MMART.
es.addEventListener("retract", () => faceEvent("error"));
es.addEventListener("index", () => faceEvent("find"));
es.addEventListener("setup_done", () => faceEvent("done"));
// An available version is news for the user, so MMART reacts — unlike the
// background broadcasts above. The face settles back to idle: the persistent
// half of the notice is the footer chip (snapshot), which needs no animation.
es.addEventListener("update", (e) => {
  const d = parse(e);
  if (d) applyUpdateEvent(d, updateHooks);
});
// Per-tab status dots: its own listeners — feed handlers stay untouched
// (source-level guards pin the handler table above). Working streams mark the
// owner tab, `question` marks waiting-for-you, `turn_end`/`error` settle it.
// Completion never steals focus, only the badge.
for (const ev of ["text", "reasoning", "phase", "tool_start", "plan"]) {
  es.addEventListener(ev, (e) => {
    const d = parse(e);
    if (d && d.sessionId) setTabStatus(d.sessionId, "working");
  });
}
es.addEventListener("question", (e) => {
  const d = parse(e);
  if (d && d.sessionId) setTabStatus(d.sessionId, "waiting");
});
es.addEventListener("turn_end", (e) => {
  const d = parse(e);
  if (d && d.sessionId) setTabStatus(d.sessionId, d.success === false && !d.interrupted ? "failed" : "idle");
});
// Sidebar Trace: live per-session event log. Feed handlers stay untouched.
// Tool/text/phase/plan/question/error stream live; status/log/retract/index
// ride the same SSE bus; critic/compaction/probe/usage/audit/claim rows
// arrive via the session-log supplement Trace pulls on every turn_end.
for (const ev of ["tool_start", "tool_end", "phase", "plan", "question", "meta", "log", "retract", "index"]) {
  es.addEventListener(ev, (e) => { const d = parse(e); if (d && sidebarOwns(d)) sidebarTraceEvent(ev, d); });
}
es.addEventListener("text", (e) => { const d = parse(e); if (d && sidebarOwns(d)) sidebarTraceEvent("text", d); });
es.addEventListener("reasoning", (e) => { const d = parse(e); if (d && sidebarOwns(d)) sidebarTraceEvent("reasoning", d); });
// LSP tab: server emits `lsp {phase}` around an on-demand diagnosis.
es.addEventListener("lsp", (e) => { const d = parse(e); if (d) sidebarLspEvent(d); });
// Files tab: workspace watcher fired — re-read the expanded directories.
  es.addEventListener("files", () => sidebarFilesChanged());
  es.addEventListener("plugins", () => { sidebarPluginsEvent(); sidebarMcpEvent(); });
// Config changed anywhere (settings write or a slash command) — re-read it so
// the open Settings panel and the composer selectors never show a stale value.
es.addEventListener("config", () => { void loadConfig(); });
es.addEventListener("command", (e) => {
  const d = parse(e);
  if (d && typeof d.text === "string") onCommandOutput(d.text, d.sessionId);
});
es.addEventListener("state", (e) => {
  const d = parse(e);
  if (!d) return;
  sidebarBusy(!!d.busy);
  applyState(d);
});
es.addEventListener("sessions", (e) => {
  const d = parse(e);
  if (d && Array.isArray(d.sessions)) {
    session.sessions = d.sessions;
    renderSessionsDropdown();
  }
});
// Live context metrics while a turn runs (server broadcasts `usage` every
// ~800ms): merge into the owning tab's snapshot without a state re-fetch.
es.addEventListener("usage", (e) => {
  const d = parse(e);
  if (!d || !d.usage || typeof d.usage !== "object") return;
  const owner = d.usageSessionId || d.sessionId || null;
  if (mergeUsage(owner, d.usage)) renderUsage(session.host);
});
  es.addEventListener("error", (e) => {
    if (!(e as MessageEvent).data) return;
    const d = parse(e as MessageEvent);
    if (d) {
      if (d.sessionId) setTabStatus(d.sessionId, "failed");
      onErrorEvent(d); sidebarTraceEvent("error", d);
    }
  });
}

// Re-apply the dictionary to static chrome after a locale switch. Dynamic
// feeds (tool output, model text) are localized server-side and untouched.
function applyStaticI18n(): void {
  document.documentElement.lang = I18N.locale;
  const setText = (id: string, text: string) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  setText("planHeaderLabel", t("web.sidebar.plan"));
  setText("usageHeaderLabel", t("web.sidebar.session") + " · " + t("web.sidebar.usage"));
  setText("envHeaderLabel", t("web.sidebar.env"));
  setText("settingsTitle", t("web.settings.title"));
  setText("sessActiveHeader", t("web.sessions.active"));
  setText("sessRecentHeader", t("web.sessions.recent"));
  setText("hintEnter", t("web.input.enter"));
  setText("hintShift", t("web.input.shift_enter"));
  setText("hintEsc", t("web.input.esc"));
  setText("hintAttach", t("web.input.attach"));
  setText("bootCap", t("web.loader.boot"));
  // MMART's click bubble: bound lazily (not at import) so `loader.ts` stays
  // import-safe under `bun test`, and re-bound here after a locale switch.
  setGreetResolver(() => t("web.loader.greet"));
  // A bubble already open must restate the greeting in the new locale.
  const greetTip = composerFace?.querySelector<HTMLElement>(".mdl-tip");
  if (greetTip) greetTip.textContent = t("web.loader.greet");

  // Chrome controls: Lucide icon + label, plus matching title/aria-label.
  const controls: Record<string, [string, string]> = {
    newChat: ["plus", t("web.topbar.new_chat")],
    sessBtn: ["menu", t("web.topbar.all_sessions")],
    toggleSidebar: ["panel", t("web.topbar.sidebar")],
    openSettings: ["settings", t("web.topbar.settings")],
    attachBtn: ["image", t("web.attach.title")],
    closeSettings: ["x", t("web.topbar.close")],
    sessNew: ["plus", t("web.sessions.new")],
    sessRefresh: ["refresh", t("web.sessions.refresh")],
    sessPrev: ["chevron-left", t("web.sessbar.prev")],
    sessNext: ["chevron-right", t("web.sessbar.next")],
    sessClose: ["x", t("web.topbar.close")],
  };
  Object.keys(controls).forEach((id) => {
    const node = document.getElementById(id);
    if (!node) return;
    const [name, label] = controls[id];
    // Text-bearing buttons keep their label; icon-only ones don't add one.
    const withLabel = id === "closeSettings" || id === "sessNew" || id === "sessRefresh";
    setIcon(node, name, withLabel ? label : null);
    node.title = label;
    node.setAttribute("aria-label", label);
  });
  const settingsIcon = document.getElementById("settingsIcon");
  if (settingsIcon) setIcon(settingsIcon, "settings", null);
  if (inp) {
    inp.placeholder = t("web.input.placeholder");
    inp.setAttribute("aria-label", t("web.input.placeholder"));
  }

  document.querySelectorAll<HTMLElement>("#setMenu .mi").forEach((mi) => {
    const p = mi.dataset.p;
    if (p) mi.textContent = t("web.settings." + p);
  });
  const settingsSearch = document.getElementById("setSearch");
  if (settingsSearch) {
    settingsSearch.setAttribute("placeholder", t("web.settings.search_placeholder"));
    settingsSearch.setAttribute("aria-label", t("web.settings.search_placeholder"));
  }
  document.querySelectorAll(".content-col .panel").forEach((panel) => {
    const h3 = panel.querySelector("h3");
    const name = panel.id.replace(/^p-/, "");
    if (h3 && name) h3.textContent = t("web.settings." + name);
  });

  renderSelectors();
  renderSessionsDropdown();
  applyRailI18n();
  applySidebarI18n();
  if (msgs.querySelector(".empty")) showEmptyFeed();
  if (connStatus && !connStatus.hidden) setConnStatus(true);
  setStaleBar(undefined, true);
}
async function boot(): Promise<void> {
  initCursor();
  // Read the requested session before `showEmptyFeed()` → `syncUrl()` can strip it.
  const initialSession = new URLSearchParams(location.search).get("session");
  // First-run wizard owns the screen when the server reports a virgin config;
  // it reloads the page once setup completes, so skip the chat boot entirely.
  if (window.MmaSetup) {
    try {
      if (await window.MmaSetup.maybeOpen()) { hideBootSplash(); return; }
    } catch {
      /* wizard failure must never brick the chat boot */
    }
  }
  // Splash is a mask, not a gate: cap at 2 s; data loads progressively behind it.
  window.setTimeout(hideBootSplash, 2000);
  try {
    await loadI18n();
    await loadCommands();
    applyTheme(currentTheme());
    applyUiTheme(currentUiTheme());
    applyFontSize();
    applyStaticI18n();
    showEmptyFeed();
    renderSelectors();
    renderSettings();
    await loadConfig();
    initRail(settings.config && settings.config.ui ? settings.config.ui.activityRail : undefined);
    initComposerFace();
    initSidebar();
    initSidebarDrawer();
    initSubagentView();
    applySidebarI18n();
    initFiles({ insertPath: (p) => insertIntoDraft("`" + p + "` ") });
    await loadModels();
    await loadProviders();
    await loadSessions();
    await loadMemory();
    await loadSkills();
    await loadPlugins();
    // Reopen remembered tabs first; `refresh()` auto-opens the server-active
    // session only when no tab is active yet, so a restored set is not clobbered.
    restoreTabs(initialSession);
    try {
      await refresh();
    } catch (err) {
      // A render bug must never kill boot before the SSE stream connects:
      // without SSE no streamed answers, tools or loaders reach the page.
      console.error("initial refresh failed", err);
    }
  } finally {
    hideBootSplash();
  }
  connectSSE();
}
// Fade the boot splash out and drop it from the layout. Idempotent.
function hideBootSplash(): void {
  const splash = document.getElementById("bootSplash");
  if (!splash || splash.hidden) return;
  splash.classList.add("hide");
  window.setTimeout(() => { splash.hidden = true; }, 500);
}

hooks.applyStaticI18n = applyStaticI18n;

void boot();
