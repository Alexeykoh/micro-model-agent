import { msgs, inp, connStatus, setIcon, icon } from "./js/dom.js";
import { api, token } from "./js/api.js";
import { I18N, t, loadI18n } from "./js/i18n.js";
import { S, hooks } from "./js/store.js";
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
} from "./js/tabs.js";
import {
renderSelectors, renderSettings, loadConfig, loadModels, loadProviders,
loadMemory, loadSkills, loadPlugins, applyTheme, currentTheme, applyFontSize, setConnStatus, setStaleBar,
} from "./js/settings.js";
import {
initRail, setPlan as railPlan, railEvent, applyRailI18n,
} from "./js/rail.js";
import {
  initSidebar, sidebarSessionChanged, sidebarMapState,
  sidebarTraceEvent, sidebarTurnEnd, sidebarBusy, sidebarMapIndicator,
  sidebarPullLog, sidebarLspState, sidebarLspEvent,
  applySidebarI18n,
} from "./js/sidebar.js";

document.querySelectorAll("[data-collapse]").forEach((head) => {
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

// Mobile sidebar: hidden by CSS under 760px, opened as an overlay drawer.
const sidebarBtn = document.getElementById("toggleSidebar");
if (sidebarBtn) {
  sidebarBtn.addEventListener("click", () => {
    const open = document.body.classList.toggle("sb-open");
    sidebarBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !document.body.classList.contains("sb-open")) return;
    const tag = document.activeElement ? String(document.activeElement.tagName) : "";
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    document.body.classList.remove("sb-open");
    sidebarBtn.setAttribute("aria-expanded", "false");
  });
}

function renderState(snapshot, busy, extra) {
  S.state.host = snapshot || {};
  S.state.busy = !!busy;
  S.state.runningSessionId = (extra && extra.runningSessionId) || null;
  S.state.runningSessionIds = (extra && extra.runningSessionIds) ||
    (S.state.runningSessionId ? [S.state.runningSessionId] : []);
  S.state.queued = (extra && extra.queued) || {};
  reflectBusy();
  reconcileTabStatuses();
  const sessionId = S.state.host.sessionId || null;
  S.state.activeSessionId = sessionId;
  if (sessionId && !S.tabs.some((x) => x.id === sessionId)) {
    openTab(sessionId, S.state.host.sessionName || String(sessionId), "session", false);
  }
  if (sessionId) updateTabName(sessionId, S.state.host.sessionName);
  if (!S.tabs.length) showEmptyFeed();
  renderPlan(S.state.host.plan);
  railPlan(busy && snapshot ? snapshot.plan : null);
  renderUsage(S.state.host);
  // Late provider auto-detect may change the effective window after boot —
  // the snapshot carries it so the topbar follows without a config re-fetch.
  if (snapshot && typeof snapshot.contextWindow === "number" && S.state.config &&
      S.state.config.contextWindow !== snapshot.contextWindow) {
    S.state.config.contextWindow = snapshot.contextWindow;
    renderSelectors();
  }
  renderEnvironment(S.state.host);
  sidebarMapState(S.state.host);
  sidebarMapIndicator(S.state.host);
  sidebarLspState();
  sidebarSessionChanged(sessionId);
  renderWorkspace(S.state.host);
  renderSessionsDropdown();
  setStaleBar(!!(snapshot && snapshot.i18nStale));
}

async function refresh() {
  const r = await api("/api/state");
  if (!r.ok || !r.data) return;
  renderState(r.data.state, r.data.busy, r.data);
}

function resyncAfterReconnect() {
  refresh();
  const tab = S.tabs.find((x) => x.id === S.activeTabId);
  if (tab && tab.kind === "session" && !feedHasContent(tab.feed)) {
    tab.historyLoaded = false;
    loadHistory(tab);
  }
}

function connectSSE() {
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
    if (e && typeof e.data === "string") return;
    dropped = true;
    setConnStatus(true);
  };
  const parse = (e) => {
    try {
      return JSON.parse(e.data);
    } catch (err) {
      return null;
    }
  };
// SSE event → feed handler table. `command`/`state`/`error` need envelope
// checks and stay bespoke below; everything else is `parse → null-guard → call`.
const handlers = [
  ["text", (d) => onText(d.chunk || "", d.sessionId)],
  ["meta", (d) => onMeta(d.chunk || "", d.sessionId, d.kind)],
  ["reasoning", (d) => onReasoning(d.chunk || "", d.sessionId)],
  ["phase", (d) => onPhase(d.phase, d.sessionId)],
  ["tool_start", onToolStart],
  ["tool_end", onToolEnd],
  ["plan", onPlan],
  ["question", onQuestion],
  ["turn_end", (d) => { onTurnEnd(d); sidebarTurnEnd(d.turnSeq); sidebarBusy(false); sidebarPullLog(); }],
  ["log", onLog],
  ["retract", (d) => onRetract(d.reason || "", d.sessionId)],
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
  if (d && d.sessionId) setTabStatus(d.sessionId, d.success === false ? "failed" : "idle");
});
// Sidebar Trace: live per-session event log. Feed handlers stay untouched.
// Tool/text/phase/plan/question/error stream live; status/log/retract/index
// ride the same SSE bus; critic/MoE/compaction/probe/usage/audit/claim rows
// arrive via the session-log supplement Trace pulls on every turn_end.
for (const ev of ["tool_start", "tool_end", "phase", "plan", "question", "meta", "log", "retract", "index"]) {
  es.addEventListener(ev, (e) => { const d = parse(e); if (d) sidebarTraceEvent(ev, d); });
}
es.addEventListener("text", (e) => { const d = parse(e); if (d) sidebarTraceEvent("text", d); });
// LSP tab: server emits `lsp {phase}` around an on-demand diagnosis.
es.addEventListener("lsp", (e) => { const d = parse(e); if (d) sidebarLspEvent(d); });
es.addEventListener("command", (e) => {
  const d = parse(e);
  if (d && typeof d.text === "string") onCommandOutput(d.text, d.sessionId);
});
  es.addEventListener("state", (e) => {
    const d = parse(e);
    if (d) {
      S.state.busy = !!d.busy;
      S.state.runningSessionId = d.runningSessionId || null;
      S.state.runningSessionIds = d.runningSessionIds ||
        (S.state.runningSessionId ? [S.state.runningSessionId] : []);
      S.state.queued = d.queued || {};
      reflectBusy();
      reconcileTabStatuses();
      sidebarBusy(!!d.busy);
      refresh();
      // Usage чужого хода в свой сайдбар не мержим: смотрим вкладку своей
      // (серверно-активной) сессии. Legacy-события без владельца — мержим,
      // как раньше. Промах по активной (гонка activate) закроет 2с-полл.
      if (d.usage && typeof d.usage === "object" &&
          (d.usageSessionId == null || d.usageSessionId === S.state.activeSessionId)) {
        S.state.host = Object.assign({}, S.state.host, d.usage);
        renderUsage(S.state.host);
      }
    }
  });
  es.addEventListener("error", (e) => {
    if (!e.data) return;
    const d = parse(e);
    if (d) {
      if (d.sessionId) setTabStatus(d.sessionId, "failed");
      onErrorEvent(d); sidebarTraceEvent("error", d);
    }
  });
}

// Re-apply the dictionary to static chrome after a locale switch. Dynamic
// feeds (tool output, model text) are localized server-side and untouched.
function applyStaticI18n() {
  document.documentElement.lang = I18N.locale;
  const setText = (id, text) => {
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

  // Chrome controls: Lucide icon + label, plus matching title/aria-label.
  const controls = {
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

  document.querySelectorAll("#setMenu .mi").forEach((mi) => {
    const p = mi.dataset.p;
    if (p) mi.textContent = t("web.settings." + p);
  });
  const settingsSearch = document.getElementById("setSearch");
  if (settingsSearch) {
    settingsSearch.placeholder = t("web.settings.search_placeholder");
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

async function boot() {
  // Read the requested session before `showEmptyFeed()` → `syncUrl()` can strip it.
  const initialSession = new URLSearchParams(location.search).get("session");
  // First-run wizard owns the screen when the server reports a virgin config;
  // it reloads the page once setup completes, so skip the chat boot entirely.
  if (window.MmaSetup) {
    try {
      if (await window.MmaSetup.maybeOpen()) return;
    } catch (err) {
      /* wizard failure must never brick the chat boot */
    }
  }
  await loadI18n();
  await loadCommands();
  applyTheme(currentTheme());
  applyFontSize();
  applyStaticI18n();
  showEmptyFeed();
  renderSelectors();
  renderSettings();
  await loadConfig();
  initRail(S.state.config && S.state.config.ui ? S.state.config.ui.activityRail : undefined);
  initSidebar();
  applySidebarI18n();
  await loadModels();
  await loadProviders();
  await loadSessions();
  await loadMemory();
  await loadSkills();
  await loadPlugins();
  await refresh();
  // Restore the session from the URL AFTER the first refresh: `renderState`
  // may auto-open the server's active session, and the requested one must win.
  if (initialSession) {
    const meta = S.state.sessions.find((s) => s.id === initialSession);
    if (meta) openTab(initialSession, meta.name || String(initialSession), "session", true);
  }
  connectSSE();
  setInterval(refresh, 2000);
  setInterval(loadSessions, 15000);
}

hooks.applyStaticI18n = applyStaticI18n;

boot();
