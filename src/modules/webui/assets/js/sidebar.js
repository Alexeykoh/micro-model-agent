// Sidebar tabs (Session / Map / Trace) for `mma web`.
//
// Owns: active-tab state (localStorage), the live per-session Trace buffer with
// master-detail expansion, and the Map tab rendering. Leaf module: imports only
// dom/i18n/format/store/api — the frontend DAG stays acyclic
// (app → sidebar → {dom,i18n,format,store,api}).
// Design: docs/specs/2026-09-30-webui-sidebar-tabs-design.md.

import { el, icon } from "./dom.js";
import { api } from "./api.js";
import { S } from "./store.js";
import { t } from "./i18n.js";
import { labelOf, categoryOf, argText, formatMs } from "./format.js";

const TAB_KEY = "mma-sidebar-tab";
const TABS = ["session", "map", "trace"];
const ICON_NAME = { session: "list-checks", map: "map", trace: "activity" };
const TRACE_CAP = 500;
const MAX_OUTPUT_CHARS = 20000;

let sbEl = null, nameEl = null, nameTextEl = null, mapEl = null, listEl = null, detailEl = null;
let detailGlyph = null, detailTitle = null, detailBody = null, detailClose = null;
let active = "session";
let trace = [];          // { id, kind, ts, name, args, output, success, durationMs, phase, text, steps, currentIndex }
let selected = null;     // trace id
let turn = 0;
let seq = 0;
const pendingArgs = new Map();  // toolCallId → args (tool_start before tool_end)
let textEntry = null;           // current text row (updated in place)

function paneEl(id) { return document.getElementById("pane-" + id); }

function mqMobile() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 760px)").matches : false;
}

function readStored() {
  try { return localStorage.getItem(TAB_KEY); } catch { return null; }
}
function storeTab(id) {
  try { localStorage.setItem(TAB_KEY, id); } catch { /* private mode */ }
}

export function setSidebarTab(id) {
  if (!TABS.includes(id)) id = "session";
  if (id === "trace" && mqMobile()) id = "session";
  active = id;
  storeTab(id);
  TABS.forEach((name) => {
    const pane = paneEl(name);
    if (pane) pane.hidden = name !== id;
    const tab = sbEl && sbEl.querySelector('.sb-tab[data-tab="' + name + '"]');
    if (tab) {
      const on = name === id;
      tab.classList.toggle("on", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    }
  });
  if (nameTextEl) nameTextEl.textContent = t("web.sidebar.tab_" + id);
  const nic = nameEl && nameEl.querySelector(".sb-ico");
  if (nic) { nic.textContent = ""; nic.appendChild(icon(ICON_NAME[id])); }
}

function collapseDetail() {
  selected = null;
  if (sbEl) sbEl.classList.remove("sb-expanded");
  if (detailEl) detailEl.hidden = true;
  if (listEl) listEl.querySelectorAll(".trc.sel").forEach((n) => n.classList.remove("sel"));
}

function phaseLabel(phase) {
  if (phase === "composing") return t("web.rail.composing");
  if (phase === "tool") return t("web.rail.working");
  if (phase === "thinking") return t("web.action.thinking");
  return String(phase || "");
}

function catClass(kind, name) {
  if (kind === "tool" || kind === "tool_fail") return categoryOf(name);
  if (kind === "phase") return "phase";
  return "meta";
}

function rowLabel(entry) {
  switch (entry.kind) {
    case "phase": return phaseLabel(entry.phase);
    case "plan": return t("web.sidebar.trace_plan");
    case "question": return t("web.sidebar.trace_question");
    case "text": return t("web.sidebar.trace_text", { count: entry.text.length });
    default: return labelOf(entry.name);
  }
}

function rowArgs(entry) {
  if (entry.kind === "text" || entry.kind === "phase") return "";
  if (entry.kind === "plan") {
    const idx = typeof entry.currentIndex === "number" ? entry.currentIndex : 0;
    const total = Array.isArray(entry.steps) ? entry.steps.length : 0;
    if (!total) return "";
    return t("web.rail.step_of", { cur: Math.min(idx + 1, total), total });
  }
  if (entry.kind === "question") return entry.text || "";
  return argText(entry.args);
}

function isWarn(entry) {
  return entry.kind === "tool_fail" || entry.kind === "error";
}

function renderRow(entry) {
  const cls = ["trc", catClass(entry.kind, entry.name)];
  if (isWarn(entry)) cls.push("warn");
  if (selected === entry.id) cls.push("sel");
  const row = el("div", cls.join(" "));
  row.dataset.id = String(entry.id);
  row.appendChild(el("span", "g", isWarn(entry) ? "⚠" : entry.kind === "question" ? "?" : "◇"));
  row.appendChild(el("span", "lab", rowLabel(entry)));
  const args = rowArgs(entry);
  if (args) row.appendChild(el("span", "args", args));
  if (entry.durationMs) row.appendChild(el("span", "t", formatMs(entry.durationMs)));
  row.addEventListener("click", () => {
    if (selected === entry.id) { collapseDetail(); return; }
    selected = entry.id;
    renderList();
    renderDetail(entry);
    if (sbEl) sbEl.classList.add("sb-expanded");
  });
  return row;
}

function renderList() {
  if (!listEl) return;
  listEl.textContent = "";
  listEl.dataset.lastTurn = "0";
  if (trace.length === 0) {
    listEl.appendChild(el("div", "trace-turn", t("web.sidebar.trace_empty")));
    return;
  }
  let shownTurn = 0;
  for (const entry of trace) {
    if (entry.turn !== shownTurn) {
      shownTurn = entry.turn;
      listEl.appendChild(el("div", "trace-turn", t("web.sidebar.trace_turn", { n: entry.turn })));
    }
    listEl.appendChild(renderRow(entry));
  }
  listEl.scrollTop = listEl.scrollHeight;
}

function append(entry) {
  entry.id = ++seq;
  entry.turn = turn;
  entry.ts = Date.now();
  trace.push(entry);
  if (trace.length > TRACE_CAP) trace.splice(0, trace.length - TRACE_CAP);
}

function pushRow(entry) {
  if (!listEl) return;
  const last = listEl.dataset.lastTurn ? Number(listEl.dataset.lastTurn) : 0;
  if (entry.turn !== last) {
    listEl.appendChild(el("div", "trace-turn", t("web.sidebar.trace_turn", { n: entry.turn })));
    listEl.dataset.lastTurn = String(entry.turn);
  }
  listEl.appendChild(renderRow(entry));
  listEl.scrollTop = listEl.scrollHeight;
}

function updateTextRow(entry) {
  const row = listEl && listEl.querySelector('.trc[data-id="' + entry.id + '"]');
  if (!row) return;
  row.textContent = "";
  row.appendChild(el("span", "g", "✦"));
  row.appendChild(el("span", "lab", rowLabel(entry)));
  listEl.scrollTop = listEl.scrollHeight;
}

// ---- public API ----

export function sidebarSessionChanged(sid) {
  const prev = sbEl && sbEl.dataset.sid;
  if (prev === (sid || "")) return;
  if (sbEl) sbEl.dataset.sid = sid || "";
  trace = [];
  textEntry = null;
  turn = 0;
  seq = 0;
  pendingArgs.clear();
  collapseDetail();
  renderList();
}

export function sidebarTurnEnd() {
  turn += 1;
  textEntry = null;
}

export function sidebarTraceEvent(kind, data) {
  if (!data) return;
  switch (kind) {
    case "tool_start":
      pendingArgs.set(data.toolCallId, data.args || {});
      append({ kind: "tool", name: data.name, args: data.args || {} });
      pushRow(trace[trace.length - 1]);
      break;
    case "tool_end": {
      const args = pendingArgs.get(data.toolCallId) || {};
      pendingArgs.delete(data.toolCallId);
      append({
        kind: data.success === false ? "tool_fail" : "tool",
        name: data.name, args, success: data.success !== false,
        durationMs: data.durationMs, output: data.output || "",
      });
      pushRow(trace[trace.length - 1]);
      break;
    }
    case "phase":
      append({ kind: "phase", phase: data.phase });
      pushRow(trace[trace.length - 1]);
      break;
    case "plan":
      append({
        kind: "plan",
        steps: Array.isArray(data.steps) ? data.steps : [],
        currentIndex: typeof data.currentIndex === "number" ? data.currentIndex : 0,
      });
      pushRow(trace[trace.length - 1]);
      break;
    case "question":
      append({ kind: "question", text: data.question || data.text || "" });
      pushRow(trace[trace.length - 1]);
      break;
    case "text": {
      if (!textEntry) { append({ kind: "text", text: "" }); textEntry = trace[trace.length - 1]; pushRow(textEntry); }
      textEntry.text += data.chunk || "";
      if (textEntry.text.length > 4000) textEntry.text = textEntry.text.slice(-4000);
      updateTextRow(textEntry);
      break;
    }
    case "error":
      append({ kind: "error", message: data.message || data.error || "" });
      pushRow(trace[trace.length - 1]);
      break;
    default:
      break;
  }
}

function detailGroup(title, bodyNode) {
  const g = el("div");
  g.appendChild(el("h5", "", title));
  g.appendChild(bodyNode);
  return g;
}
function kv(label, value) {
  const row = el("div", "kv");
  row.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  row.appendChild(b);
  return row;
}
function codeBlock(text) {
  const c = el("div", "code");
  c.textContent = text;
  return c;
}

function renderDetail(entry) {
  if (!detailEl) return;
  detailEl.hidden = false;
  const warn = isWarn(entry);
  detailGlyph.textContent = warn ? "⚠" : entry.kind === "question" ? "?" : "◇";
  detailGlyph.style.color = warn ? "var(--yellow)" : "var(--accent)";
  detailTitle.textContent = rowLabel(entry);
  detailBody.textContent = "";

  const meta = el("div");
  meta.appendChild(el("h5", "", t("web.sidebar.detail_metadata")));
  const d = entry.ts ? new Date(entry.ts) : null;
  if (entry.kind === "tool" || entry.kind === "tool_fail") {
    meta.appendChild(kv(t("web.sidebar.detail_status"), entry.success === false ? t("web.sidebar.detail_fail") : t("web.sidebar.detail_ok")));
    if (entry.durationMs) meta.appendChild(kv(t("web.sidebar.detail_duration"), formatMs(entry.durationMs)));
  }
  if (d) meta.appendChild(kv(t("web.sidebar.detail_time"), d.toLocaleTimeString()));
  if (entry.toolCallId) meta.appendChild(kv(t("web.sidebar.detail_tool_call"), String(entry.toolCallId)));
  if (sbEl && sbEl.dataset.sid) meta.appendChild(kv(t("web.sidebar.detail_session"), sbEl.dataset.sid));
  detailBody.appendChild(meta);

  if (entry.kind === "tool" || entry.kind === "tool_fail") {
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_arguments"), codeBlock(JSON.stringify(entry.args || {}, null, 2))));
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_output"), codeBlock((entry.output || "").slice(0, MAX_OUTPUT_CHARS))));
  } else if (entry.kind === "text") {
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_text"), codeBlock(entry.text || "")));
  } else if (entry.kind === "plan") {
    const list = el("div");
    (entry.steps || []).forEach((s) => {
      const mark = s.status === "done" ? "✓" : s.status === "failed" ? "✗" : s.status === "in_progress" ? "▸" : "○";
      const cls = s.status === "failed" ? "fail" : s.status === "in_progress" ? "cur" : s.status === "done" ? "done" : "";
      list.appendChild(el("div", ("plan-step " + cls).trim(), mark + " " + s.text));
    });
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_plan"), list));
  } else if (entry.kind === "question") {
    detailBody.appendChild(detailGroup(t("web.sidebar.trace_question"), codeBlock(entry.text || "")));
  } else if (entry.kind === "error") {
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_error"), codeBlock(entry.message || "")));
  }
}

// ---- Map tab ----

function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n || 0);
}

function fmtUpdated(updatedAt) {
  if (typeof updatedAt !== "number") return t("web.sidebar.map_never");
  const d = new Date(updatedAt);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toTimeString().slice(0, 5);
  return sameDay ? t("web.sidebar.map_today", { time }) : d.toLocaleString();
}

function mapKv(label, value, cls) {
  const row = el("div", ("kv" + (cls ? " " + cls : "")).trim());
  row.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  row.appendChild(b);
  return row;
}

let reindexing = false;   // клиентский спиннер до свежего снапшота
let postResolved = false; // POST вернулся; следующий снапшот снимет спиннер
let reindexError = false; // последний POST не удался

export function sidebarMapState(host) {
  if (!mapEl) return;
  const map = (host && host.projectMap) || null;
  const serverIndexing = !!(map && map.indexing);
  if (postResolved && !serverIndexing) { reindexing = false; postResolved = false; }
  const indexing = serverIndexing || reindexing;
  mapEl.textContent = "";
  if (!map) {
    mapEl.appendChild(mapKv(t("web.sidebar.map_status"), t("web.sidebar.map_never")));
    return;
  }
  const status = indexing ? t("web.sidebar.map_indexing")
    : !map.indexed ? t("web.sidebar.map_never")
    : (map.watcher ? t("web.sidebar.map_ready") : t("web.sidebar.map_stale"));
  mapEl.appendChild(mapKv(t("web.sidebar.map_status"), status));
  mapEl.appendChild(mapKv(t("web.sidebar.map_updated"), fmtUpdated(map.updatedAt)));
  mapEl.appendChild(mapKv(t("web.sidebar.map_watcher"), map.watcher ? t("web.sidebar.map_on") : t("web.sidebar.map_off")));
  mapEl.appendChild(mapKv(t("web.sidebar.map_files"), String(map.files || 0)));
  mapEl.appendChild(mapKv(t("web.sidebar.map_symbols"), String(map.symbols || 0)));
  mapEl.appendChild(mapKv(t("web.sidebar.map_tokens"), fmtTokens(map.tokens)));
  if (host && host.workspace) mapEl.appendChild(mapKv(t("web.sidebar.map_root"), host.workspace));

  if (Array.isArray(map.languages) && map.languages.length > 0) {
    const head = el("div", "kv");
    head.appendChild(el("span", "dim", t("web.sidebar.map_languages")));
    mapEl.appendChild(head);
    map.languages.forEach((l) => mapEl.appendChild(mapKv(l.language, l.files + " · " + l.symbols)));
  }
  if (reindexError) mapEl.appendChild(mapKv(t("web.sidebar.map_reindex_failed"), "—", "wn"));

  const btn = el("button", "map-reindex", indexing ? t("web.sidebar.map_reindexing") : t("web.sidebar.map_reindex"));
  btn.type = "button";
  btn.disabled = indexing;
  btn.addEventListener("click", async () => {
    reindexing = true;
    postResolved = false;
    reindexError = false;
    sidebarMapState(host);
    const r = await api("/api/index", { method: "POST" });
    if (!r.ok) {
      reindexing = false;
      postResolved = false;
      reindexError = true;
      sidebarMapState(host);
      return;
    }
    // Свежий снапшот (поллинг / `state`-broadcast по завершении) снимет спиннер.
    postResolved = true;
  });
  mapEl.appendChild(btn);
}

// ---- indicators ----

export function sidebarBusy(on) {
  const tab = sbEl && sbEl.querySelector('.sb-tab[data-tab="trace"]');
  if (tab) tab.dataset.indicator = on ? "live" : "";
}
export function sidebarMapIndicator(host) {
  const tab = sbEl && sbEl.querySelector('.sb-tab[data-tab="map"]');
  if (!tab) return;
  const map = (host && host.projectMap) || null;
  const next = map && map.indexing ? "busy" : map && map.indexed && !map.watcher ? "stale" : "";
  tab.dataset.indicator = next;
}

// ---- init / i18n ----

export function applySidebarI18n() {
  if (!sbEl) return;
  TABS.forEach((id) => {
    const tab = sbEl.querySelector('.sb-tab[data-tab="' + id + '"]');
    if (tab) { const label = t("web.sidebar.tab_" + id); tab.title = label; tab.setAttribute("aria-label", label); }
  });
  setSidebarTab(active);
  renderList();
  if (selected) {
    const entry = trace.find((x) => x.id === selected);
    if (entry) renderDetail(entry);
  }
  sidebarMapState(S.state.host);
}

export function initSidebar() {
  sbEl = document.querySelector(".sb");
  if (!sbEl) return;
  nameEl = document.getElementById("sbName");
  nameTextEl = document.getElementById("sbNameText");
  mapEl = document.getElementById("mapBody");
  listEl = document.getElementById("traceList");
  detailEl = document.getElementById("traceDetail");
  detailGlyph = document.getElementById("detailGlyph");
  detailTitle = document.getElementById("detailTitle");
  detailBody = document.getElementById("detailBody");
  detailClose = document.getElementById("detailClose");
  if (detailClose) detailClose.addEventListener("click", collapseDetail);

  sbEl.querySelectorAll(".sb-tab .sb-ico").forEach((span) => {
    const id = span.closest(".sb-tab").dataset.tab;
    span.textContent = "";
    span.appendChild(icon(ICON_NAME[id]));
  });

  sbEl.querySelectorAll(".sb-tab").forEach((tab) => {
    tab.addEventListener("click", () => setSidebarTab(tab.dataset.tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = TABS.indexOf(tab.dataset.tab);
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      setSidebarTab(next);
      const focus = sbEl.querySelector('.sb-tab[data-tab="' + next + '"]');
      if (focus) focus.focus();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (!e.altKey || !["1", "2", "3"].includes(e.key)) return;
    const tag = document.activeElement ? String(document.activeElement.tagName) : "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    setSidebarTab(TABS[Number(e.key) - 1]);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selected) collapseDetail();
  });

  const stored = readStored();
  setSidebarTab(stored && TABS.includes(stored) ? stored : "session");
  renderList();
}
