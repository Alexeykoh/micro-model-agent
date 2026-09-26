import { msgs, inp, connStatus, setIcon, icon } from "./js/dom.js";
import { api, token } from "./js/api.js";
import { I18N, t, loadI18n } from "./js/i18n.js";
import { S, hooks } from "./js/store.js";
import {
onText, onReasoning, onMeta, onPhase, onToolStart, onToolEnd,
onTurnEnd, onErrorEvent, onCommandOutput, onLog, onCritic, onPlan, onQuestion,
showEmptyFeed, renderPlan, renderUsage, renderEnvironment, renderWorkspace,
feedHasContent, loadHistory,
} from "./js/feed.js";
import {
openTab, updateTabName, renderSessionsDropdown, reflectBusy, loadSessions,
loadCommands,
} from "./js/tabs.js";
import {
renderSelectors, renderSettings, loadConfig, loadModels, loadProviders,
loadMemory, loadSkills, loadPlugins, applyTheme, currentTheme, setConnStatus,
} from "./js/settings.js";

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

function renderState(snapshot, busy) {
  S.state.host = snapshot || {};
  S.state.busy = !!busy;
  reflectBusy();
  const sessionId = S.state.host.sessionId || null;
  S.state.activeSessionId = sessionId;
  if (sessionId && !S.tabs.some((x) => x.id === sessionId)) {
    openTab(sessionId, S.state.host.sessionName || String(sessionId), "session", false);
  }
  if (sessionId) updateTabName(sessionId, S.state.host.sessionName);
  if (!S.tabs.length) showEmptyFeed();
  renderPlan(S.state.host.plan);
  renderUsage(S.state.host);
  renderEnvironment(S.state.host);
  renderWorkspace(S.state.host);
  renderSessionsDropdown();
}

async function refresh() {
  const r = await api("/api/state");
  if (!r.ok || !r.data) return;
  renderState(r.data.state, r.data.busy);
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
  es.addEventListener("text", (e) => {
    const d = parse(e);
    if (d) onText(d.chunk || "", d.sessionId);
  });
  es.addEventListener("meta", (e) => {
    const d = parse(e);
    if (d) onMeta(d.chunk || "", d.sessionId);
  });
  es.addEventListener("reasoning", (e) => {
    const d = parse(e);
    if (d) onReasoning(d.chunk || "", d.sessionId);
  });
  es.addEventListener("phase", (e) => {
    const d = parse(e);
    if (d) onPhase(d.phase, d.sessionId);
  });
  es.addEventListener("tool_start", (e) => {
    const d = parse(e);
    if (d) onToolStart(d);
  });
  es.addEventListener("tool_end", (e) => {
    const d = parse(e);
    if (d) onToolEnd(d);
  });
  es.addEventListener("plan", (e) => {
    const d = parse(e);
    if (d) onPlan(d);
  });
  es.addEventListener("critic", (e) => {
    const d = parse(e);
    if (d) onCritic(d);
  });
  es.addEventListener("question", (e) => {
    const d = parse(e);
    if (d) onQuestion(d);
  });
  es.addEventListener("turn_end", (e) => {
    const d = parse(e);
    if (d) onTurnEnd(d);
  });
  es.addEventListener("command", (e) => {
    const d = parse(e);
    if (d && typeof d.text === "string") onCommandOutput(d.text, d.sessionId);
  });
  es.addEventListener("log", (e) => {
    const d = parse(e);
    if (d) onLog(d);
  });
  es.addEventListener("state", (e) => {
    const d = parse(e);
    if (d) {
      S.state.busy = !!d.busy;
      reflectBusy();
      if (d.usage && typeof d.usage === "object") {
        S.state.host = Object.assign({}, S.state.host, d.usage);
        renderUsage(S.state.host);
      }
    }
  });
  es.addEventListener("error", (e) => {
    if (!e.data) return;
    const d = parse(e);
    if (d) onErrorEvent(d);
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
    openSettings: ["settings", t("web.topbar.settings")],
    attachBtn: ["image", t("web.attach.title")],
    closeSettings: ["x", t("web.topbar.close")],
    sessNew: ["plus", t("web.sessions.new")],
    sessRefresh: ["refresh", t("web.sessions.refresh")],
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
  document.querySelectorAll(".content-col .panel").forEach((panel) => {
    const h3 = panel.querySelector("h3");
    const name = panel.id.replace(/^p-/, "");
    if (h3 && name) h3.textContent = t("web.settings." + name);
  });

  renderSelectors();
  renderSessionsDropdown();
  if (msgs.querySelector(".empty")) showEmptyFeed();
  if (connStatus && !connStatus.hidden) setConnStatus(true);
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
  applyStaticI18n();
  showEmptyFeed();
  renderSelectors();
  renderSettings();
  await loadConfig();
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
