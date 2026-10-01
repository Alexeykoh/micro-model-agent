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
import { labelOf, categoryOf, argText, formatMs, fmtTokens } from "./format.js";

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
let logCursor = null;    // max session-log ts already pulled (supplement fetch)
let logPulling = false;
const nodeById = new Map();   // entry id → row node
const callIndex = new Map();  // toolCallId → entry
const headerByTurn = new Map(); // turn → header node
let textEntry = null;         // current text row (updated in place)

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

export function setSidebarTab(id, persist = true) {
  if (!TABS.includes(id)) id = "session";
  if (persist) storeTab(id);
  const effective = id === "trace" && mqMobile() ? "session" : id;
  if (effective !== active) collapseDetail();
  active = effective;
  TABS.forEach((name) => {
    const pane = paneEl(name);
    if (pane) pane.hidden = name !== effective;
    const tab = sbEl && sbEl.querySelector('.sb-tab[data-tab="' + name + '"]');
    if (tab) {
      const on = name === effective;
      tab.classList.toggle("on", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    }
  });
  if (nameTextEl) nameTextEl.textContent = t("web.sidebar.tab_" + effective);
  const nic = nameEl && nameEl.querySelector(".sb-ico");
  if (nic) { nic.textContent = ""; nic.appendChild(icon(ICON_NAME[effective])); }
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
    case "text": return t("web.sidebar.trace_text", { count: entry.chars || 0 });
    case "status": return t("web.sidebar.trace_status");
    case "log": return t("web.sidebar.trace_log", { level: entry.level || "" });
    case "retract": return t("web.sidebar.trace_retract");
    case "index": return t("web.sidebar.trace_index", { phase: entry.phase || "" });
    case "critic": return t("web.sidebar.trace_critic", { status: entry.status || "" });
    case "moe": return t("web.sidebar.trace_moe");
    case "compaction": return t("web.sidebar.trace_compaction");
    case "probe": return t("web.sidebar.trace_probe");
    case "usage": return t("web.sidebar.trace_usage");
    case "audit": return t("web.sidebar.trace_audit");
    case "claim": return t("web.sidebar.trace_claim", { kind: entry.subkind || "" });
    case "output": return t("web.sidebar.trace_output");
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
  // Диагностические строки несут смысл в одной строке (статус/лог/ретракт/
  // индекс/критик/MoE/компакция/проба/usage/аудит/claim/вывод).
  if (entry.text && typeof entry.text === "string" && entry.kind !== "tool" && entry.kind !== "tool_fail") {
    const line = entry.text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
    return line.slice(0, 160);
  }
  return argText(entry.args);
}

function isWarn(entry) {
  return entry.kind === "tool_fail" || entry.kind === "error" || entry.kind === "claim" ||
    (entry.kind === "critic" && entry.status === "critical") ||
    (entry.kind === "log" && (entry.level === "warn" || entry.level === "error"));
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
    if (listEl) listEl.querySelectorAll(".trc.sel").forEach((n) => n.classList.remove("sel"));
    selected = entry.id;
    row.classList.add("sel");
    renderDetail(entry);
    if (sbEl) sbEl.classList.add("sb-expanded");
  });
  return row;
}

function renderList() {
  if (!listEl) return;
  listEl.textContent = "";
  listEl.dataset.lastTurn = "-1";
  nodeById.clear();
  headerByTurn.clear();
  if (selected && !trace.some((e) => e.id === selected)) selected = null;
  if (trace.length === 0) {
    listEl.appendChild(el("div", "trace-turn", t("web.sidebar.trace_empty")));
    return;
  }
  let shownTurn = -1;
  for (const entry of trace) {
    if (entry.turn !== shownTurn) {
      shownTurn = entry.turn;
      const h = el("div", "trace-turn", t("web.sidebar.trace_turn", { n: entry.turn }));
      headerByTurn.set(entry.turn, h);
      listEl.appendChild(h);
    }
    const row = renderRow(entry);
    nodeById.set(entry.id, row);
    listEl.appendChild(row);
  }
  listEl.dataset.lastTurn = String(shownTurn);
  listEl.scrollTop = listEl.scrollHeight;
}

function append(entry) {
  entry.id = ++seq;
  entry.turn = turn;
  entry.ts = Date.now();
  trace.push(entry);
  while (trace.length > TRACE_CAP) {
    const old = trace.shift();
    const node = nodeById.get(old.id);
    if (node) { node.remove(); nodeById.delete(old.id); }
    if (old.toolCallId != null) callIndex.delete(old.toolCallId);
    if (!trace.some((e) => e.turn === old.turn)) {
      const h = headerByTurn.get(old.turn);
      if (h) { h.remove(); headerByTurn.delete(old.turn); }
    }
  }
  return entry;
}

function pushRow(entry) {
  if (!listEl) return;
  const last = listEl.dataset.lastTurn ? Number(listEl.dataset.lastTurn) : -1;
  if (entry.turn !== last) {
    const h = el("div", "trace-turn", t("web.sidebar.trace_turn", { n: entry.turn }));
    headerByTurn.set(entry.turn, h);
    listEl.appendChild(h);
    listEl.dataset.lastTurn = String(entry.turn);
  }
  const row = renderRow(entry);
  nodeById.set(entry.id, row);
  listEl.appendChild(row);
  listEl.scrollTop = listEl.scrollHeight;
}

function replaceRow(entry) {
  const old = nodeById.get(entry.id);
  const next = renderRow(entry);
  nodeById.set(entry.id, next);
  if (old && old.parentNode) old.replaceWith(next);
  else if (listEl) listEl.appendChild(next);
  if (listEl) listEl.scrollTop = listEl.scrollHeight;
}

function updateTextRow(entry) {
  const row = nodeById.get(entry.id);
  if (!row) return;
  row.textContent = "";
  row.appendChild(el("span", "g", "✦"));
  row.appendChild(el("span", "lab", rowLabel(entry)));
  if (listEl) listEl.scrollTop = listEl.scrollHeight;
}

// ---- public API ----

export function sidebarSessionChanged(sid) {
  const prev = sbEl && sbEl.dataset.sid;
  if (prev === (sid || "")) return;
  if (sbEl) sbEl.dataset.sid = sid || "";
  trace = [];
  callIndex.clear();
  textEntry = null;
  turn = 0;
  seq = 0;
  // Trace живой: старые ходы чужой сессии не докачиваем, только новые события.
  logCursor = new Date().toISOString();
  logPulling = false;
  collapseDetail();
  renderList();
}

export function sidebarTurnEnd(turnSeq) {
  // Серверный номер хода (реконнекты локальный счётчик не сбивают).
  turn = typeof turnSeq === "number" && turnSeq > turn ? turnSeq : turn + 1;
  textEntry = null;
}

export function sidebarTraceEvent(kind, data) {
  if (!data) return;
  switch (kind) {
    case "tool_start": {
      const entry = append({ kind: "tool", name: data.name, args: data.args || {}, toolCallId: data.toolCallId });
      if (data.toolCallId != null) callIndex.set(data.toolCallId, entry);
      pushRow(entry);
      break;
    }
    case "tool_end": {
      const entry = data.toolCallId != null ? callIndex.get(data.toolCallId) : undefined;
      if (data.toolCallId != null) callIndex.delete(data.toolCallId);
      if (entry) {
        entry.kind = data.success === false ? "tool_fail" : "tool";
        entry.success = data.success !== false;
        entry.durationMs = data.durationMs;
        entry.output = data.output || "";
        replaceRow(entry);
      } else {
        const e2 = append({
          kind: data.success === false ? "tool_fail" : "tool",
          name: data.name, args: data.args || {}, toolCallId: data.toolCallId,
          success: data.success !== false, durationMs: data.durationMs, output: data.output || "",
        });
        pushRow(e2);
      }
      break;
    }
    case "phase":
      if (data.phase !== "done") pushRow(append({ kind: "phase", phase: data.phase }));
      break;
    case "plan":
      pushRow(append({
        kind: "plan",
        steps: Array.isArray(data.steps) ? data.steps : [],
        currentIndex: typeof data.currentIndex === "number" ? data.currentIndex : 0,
      }));
      break;
    case "question":
      pushRow(append({ kind: "question", text: data.question || data.text || "" }));
      break;
    case "text": {
      if (!textEntry) { textEntry = append({ kind: "text", text: "", chars: 0 }); pushRow(textEntry); }
      const chunk = data.chunk || "";
      textEntry.chars += chunk.length;
      textEntry.text += chunk;
      // Полный текст хода — в память (деталь покажет целиком); обрезка честная,
      // тем же капом и маркером, что у выводов тулов.
      if (textEntry.text.length > MAX_OUTPUT_CHARS) {
        textEntry.text = textEntry.text.slice(0, MAX_OUTPUT_CHARS) +
          "\n… [truncated from " + textEntry.chars + " chars]";
      }
      updateTextRow(textEntry);
      break;
    }
    case "error":
      pushRow(append({ kind: "error", message: data.message || data.error || "" }));
      break;
    case "meta": {
      // Тела тулов (`kind: "tool"`) уже идут строками tool_start/tool_end —
      // в Trace несём только статусы (stuck/escalation/honest-stop и т.п.).
      if (data.kind !== undefined && data.kind !== "status") break;
      const text = data.chunk || "";
      if (!text.trim()) break;
      pushRow(append({ kind: "status", text }));
      break;
    }
    case "log": {
      // Внутренний шёпот петли (`diagnostic` + info) в Trace не несём —
      // только варнинги/ошибки и пользовательские info (probe/overflow).
      if (data.diagnostic && data.level === "info") break;
      const text = data.text || "";
      if (!text.trim()) break;
      pushRow(append({ kind: "log", text, level: data.level || "", source: data.source || "" }));
      break;
    }
    case "retract":
      pushRow(append({ kind: "retract", text: data.reason || "" }));
      break;
    case "index": {
      const stats = data.stats && typeof data.stats === "object"
        ? Object.entries(data.stats).map(([k, v]) => k + ": " + v).join(", ")
        : "";
      pushRow(append({ kind: "index", phase: data.phase || "", text: stats }));
      break;
    }
    default:
      break;
  }
}

/**
 * Докачка диагностических событий из session-лога (критик, MoE, компакция,
 * проба контекста, usage, аудит, claim-retry, вывод). Отдельных SSE-продюсеров
 * нет — данные уже лежат в логе с `iteration`; тянем инкремент по курсору на
 * каждый `turn_end`. Живые tool/text-строки не дублируются (другие kinds).
 */
export async function sidebarPullLog() {
  const sid = sbEl && sbEl.dataset.sid;
  if (!sid || logPulling) return;
  logPulling = true;
  try {
    let url = "/api/sessions/" + encodeURIComponent(sid) + "/log?limit=100";
    if (logCursor) url += "&since=" + encodeURIComponent(logCursor);
    const r = await api(url);
    if (!r.ok || !r.data || !Array.isArray(r.data.log)) return;
    for (const e of r.data.log) {
      if (typeof e.ts === "string" && (logCursor === null || e.ts > logCursor)) logCursor = e.ts;
      appendLogEntry(e);
    }
  } catch {
    /* best-effort supplement: Trace живёт и без докачки */
  } finally {
    logPulling = false;
  }
}

function appendLogEntry(e) {
  if (!e || typeof e.type !== "string") return;
  switch (e.type) {
    case "critic_check":
      pushRow(append({ kind: "critic", status: "check", text: "", iteration: e.iteration }));
      break;
    case "critic_verdict":
      pushRow(append({ kind: "critic", status: e.status || "", text: e.content || "", iteration: e.iteration }));
      break;
    case "critic_escalation":
      pushRow(append({ kind: "critic", status: "escalation", text: e.content || "", iteration: e.iteration }));
      break;
    case "moe_plan":
    case "moe_subtask":
    case "moe_replan":
    case "moe_verify": {
      const bits = [e.title, e.subtaskId, e.expertTag, e.status].filter((x) => typeof x === "string" && x).join(" · ");
      pushRow(append({ kind: "moe", subtype: e.type, text: bits, iteration: e.iteration }));
      break;
    }
    case "compaction":
      pushRow(append({ kind: "compaction", text: e.content || "", iteration: e.iteration }));
      break;
    case "context_probe":
      pushRow(append({ kind: "probe", text: e.content || "" }));
      break;
    case "llm_usage": {
      const toks = typeof e.totalTokens === "number" ? e.totalTokens : (e.promptTokens || 0) + (e.completionTokens || 0);
      const who = [e.model || e.provider, toks ? toks + " tok" : ""].filter(Boolean).join(" · ");
      pushRow(append({ kind: "usage", text: who, iteration: e.iteration }));
      break;
    }
    case "audit":
      pushRow(append({ kind: "audit", text: e.content || "", iteration: e.iteration }));
      break;
    case "claim_retry":
      pushRow(append({ kind: "claim", subkind: e.kind || "", text: e.content || "", iteration: e.iteration }));
      break;
    case "output":
      pushRow(append({ kind: "output", text: e.content || "", iteration: e.iteration }));
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
function capOutput(text) {
  if (typeof text !== "string") return "";
  return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(0, MAX_OUTPUT_CHARS) + "\n… [truncated from " + text.length + " chars]";
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
  meta.appendChild(kv(t("web.sidebar.detail_turn"), String(entry.turn)));
  if (typeof entry.iteration === "number") meta.appendChild(kv(t("web.sidebar.detail_iteration"), String(entry.iteration)));
  detailBody.appendChild(meta);

  if (entry.kind === "tool" || entry.kind === "tool_fail") {
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_arguments"), codeBlock(JSON.stringify(entry.args || {}, null, 2))));
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_output"), codeBlock(capOutput(entry.output))));
  } else if (entry.kind === "text") {
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_text"), codeBlock(entry.text || "")));
    loadTextProvenance(entry);
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
  } else if (
    entry.kind === "status" || entry.kind === "log" || entry.kind === "retract" ||
    entry.kind === "index" || entry.kind === "critic" || entry.kind === "moe" ||
    entry.kind === "compaction" || entry.kind === "probe" || entry.kind === "usage" ||
    entry.kind === "audit" || entry.kind === "claim" || entry.kind === "output"
  ) {
    const title =
      entry.kind === "moe" && entry.subtype ? entry.subtype
      : entry.kind === "log" && entry.level ? "log · " + entry.level
      : entry.kind === "index" && entry.phase ? "index · " + entry.phase
      : entry.kind === "critic" && entry.status ? "critic · " + entry.status
      : entry.kind === "claim" && entry.subkind ? "claim_retry · " + entry.subkind
      : rowLabel(entry);
    detailBody.appendChild(detailGroup(title, codeBlock(entry.text || "")));
  }
}

/**
 * Привязка текста хода к session-логу: сколько assistant-сообщений в сессии,
 * их итерации и провенанс последнего LLM-вызова (модель/провайдер/токены).
 * Живой текст хода уже показан выше целиком; это — сверка с логом.
 */
async function loadTextProvenance(entry) {
  const sid = sbEl && sbEl.dataset.sid;
  if (!sid || !detailBody || selected !== entry.id) return;
  try {
    const r = await api(
      "/api/sessions/" + encodeURIComponent(sid) + "/log?types=assistant,llm_usage&limit=20",
    );
    if (!r.ok || !r.data || !Array.isArray(r.data.log) || selected !== entry.id) return;
    const assistants = r.data.log.filter((e) => e.type === "assistant");
    const usages = r.data.log.filter((e) => e.type === "llm_usage");
    const iters = assistants.map((e) => e.iteration).filter((n) => typeof n === "number");
    const last = usages.length > 0 ? usages[usages.length - 1] : null;
    const bits = [
      t("web.sidebar.detail_provenance_count", { n: assistants.length }) +
        (iters.length > 0 ? " · iter " + Math.min(...iters) + "–" + Math.max(...iters) : ""),
      last
        ? [last.model || last.provider, last.totalTokens ?? (last.promptTokens || 0) + (last.completionTokens || 0)]
            .filter(Boolean)
            .join(" · ")
        : "",
    ].filter(Boolean).join("\n");
    if (bits) detailBody.appendChild(detailGroup(t("web.sidebar.detail_provenance"), codeBlock(bits)));
  } catch {
    /* best-effort: живой текст уже на месте */
  }
}

// ---- Map tab ----

function fmtUpdated(updatedAt) {
  if (typeof updatedAt !== "number") return t("web.sidebar.map_never");
  const d = new Date(updatedAt);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const time = pad(d.getHours()) + ":" + pad(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return t("web.sidebar.map_today", { time });
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + time;
}

function mapKv(label, value, cls) {
  const row = el("div", ("kv" + (cls ? " " + cls : "")).trim());
  row.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  row.appendChild(b);
  return row;
}

// Корень — всегда длинный путь: подпись сверху, путь снизу на всю ширину.
// В одну flex-строку с подписью он не влезает и склеивается с ней.
function mapPathRow(label, value) {
  const wrap = el("div", "map-path");
  wrap.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  b.title = value;
  wrap.appendChild(b);
  return wrap;
}

let reindexing = false;   // клиентский спиннер до свежего снапшота
let postResolved = false; // POST вернулся; следующий снапшот снимет спиннер
let reindexError = false; // последний POST не удался

export function sidebarMapState(host) {
  if (!mapEl) return;
  const map = (host && host.projectMap) || { indexed: false, files: 0, symbols: 0, tokens: 0, languages: [] };
  const serverIndexing = !!(map && map.indexing);
  if (postResolved && !serverIndexing) { reindexing = false; postResolved = false; }
  const indexing = serverIndexing || reindexing;
  const num = (v) => (map.indexed ? String(v || 0) : "—");
  mapEl.textContent = "";
  const status = indexing ? t("web.sidebar.map_indexing")
    : !map.indexed ? t("web.sidebar.map_never")
    : (map.watcher ? t("web.sidebar.map_ready") : t("web.sidebar.map_stale"));
  mapEl.appendChild(mapKv(t("web.sidebar.map_status"), status));
  mapEl.appendChild(mapKv(t("web.sidebar.map_updated"), fmtUpdated(map.updatedAt)));
  mapEl.appendChild(mapKv(t("web.sidebar.map_watcher"), map.watcher ? t("web.sidebar.map_on") : t("web.sidebar.map_off")));
  mapEl.appendChild(mapKv(t("web.sidebar.map_files"), num(map.files)));
  mapEl.appendChild(mapKv(t("web.sidebar.map_symbols"), num(map.symbols)));
  mapEl.appendChild(mapKv(t("web.sidebar.map_tokens"), map.indexed ? fmtTokens(map.tokens || 0) : "—"));
  if (host && host.workspace) mapEl.appendChild(mapPathRow(t("web.sidebar.map_root"), host.workspace));

  if (Array.isArray(map.languages) && map.languages.length > 0) {
    const head = el("div", "kv");
    head.appendChild(el("span", "dim", t("web.sidebar.map_languages")));
    mapEl.appendChild(head);
    map.languages.forEach((l) => mapEl.appendChild(mapKv(l.language, l.files + " · " + l.symbols)));
  }
  if (reindexError) mapEl.appendChild(mapKv(t("web.sidebar.map_reindex_failed"), "—", "wn"));

  const btn = el("button", "map-reindex", indexing ? t("web.sidebar.map_reindexing") : t("web.sidebar.map_reindex"));
  btn.type = "button";
  btn.disabled = indexing || !map.indexed;
  btn.addEventListener("click", async () => {
    reindexing = true;
    postResolved = false;
    reindexError = false;
    sidebarMapState(host);
    sidebarMapIndicator(host);
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
  const busy = (map && map.indexing) || reindexing;
  const next = busy ? "busy" : map && map.indexed && !map.watcher ? "stale" : "";
  tab.dataset.indicator = next;
}

// ---- init / i18n ----

export function applySidebarI18n() {
  if (!sbEl) return;
  TABS.forEach((id) => {
    const tab = sbEl.querySelector('.sb-tab[data-tab="' + id + '"]');
    if (tab) { const label = t("web.sidebar.tab_" + id); tab.title = label; tab.setAttribute("aria-label", label); }
  });
  setSidebarTab(active, false);
  renderList();
  if (selected) {
    const entry = trace.find((x) => x.id === selected);
    if (entry) renderDetail(entry);
  }
  sidebarMapState(S.state.host);
}

export function initSidebar() {
  if (sbEl) return;
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
