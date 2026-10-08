// Trace tab for `mma web`: live per-session event buffer with master-detail
// expansion, plus the log-supplement fetch. Split out of `sidebar.js`.
import { el } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { labelOf, categoryOf, argText, formatMs } from "../format.js";
import { createFace, setFaceState, toolState } from "../loader.js";
import type { FaceState } from "../loader.js";
import type { Dict } from "../core/store/types.js";
import { sb, paneEl, TRACE_CAP, MAX_OUTPUT_CHARS, type TraceEntry } from "./state.js";

// Small always-on face at the top of the Trace pane: reflects the live
// session activity (falls back to the idle, cursor-following face).
let faceEl: HTMLElement | null = null;

export function initTraceFace(): void {
  const host = document.querySelector(".trc-face");
  if (!host) return;
  faceEl = createFace("idle", "sm");
  host.replaceChildren(faceEl);
}

export function setTraceFace(state: FaceState): void {
  setFaceState(faceEl, state);
}

function traceFaceFor(kind: string, data: Dict): FaceState {
  switch (kind) {
    case "tool_start":
    case "tool_fail":
    case "tool":
      return toolState(typeof data.name === "string" ? data.name : "");
    case "phase":
      return data.phase === "composing" ? "type" : data.phase === "tool" ? "run" : "think";
    case "text": return "type";
    case "question": return "ask";
    case "plan": return "plan";
    case "error":
    case "retract": return "error";
    case "compaction": return "compact";
    case "index": return "run";
    default: return "think";
  }
}

function phaseLabel(phase: unknown): string {
  if (phase === "composing") return t("web.rail.composing");
  if (phase === "tool") return t("web.rail.working");
  if (phase === "thinking") return t("web.action.thinking");
  return String(phase || "");
}

function catClass(kind: string, name: string): string {
  if (kind === "tool" || kind === "tool_fail") return categoryOf(name);
  if (kind === "phase") return "phase";
  return "meta";
}

function rowLabel(entry: TraceEntry): string {
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

function rowArgs(entry: TraceEntry): string {
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
    const line = entry.text.split("\n").map((l: string) => l.trim()).find((l: string) => l.length > 0) || "";
    return line.slice(0, 160);
  }
  return argText(entry.args);
}

function isWarn(entry: TraceEntry): boolean {
  return entry.kind === "tool_fail" || entry.kind === "error" || entry.kind === "claim" ||
    (entry.kind === "critic" && entry.status === "critical") ||
    (entry.kind === "log" && (entry.level === "warn" || entry.level === "error"));
}

function renderRow(entry: TraceEntry): HTMLElement {
  const cls = ["trc", catClass(entry.kind, entry.name)];
  if (isWarn(entry)) cls.push("warn");
  if (sb.selected === entry.id) cls.push("sel");
  const row = el("div", cls.join(" "));
  row.dataset.id = String(entry.id);
  row.appendChild(el("span", "g", isWarn(entry) ? "⚠" : entry.kind === "question" ? "?" : "◇"));
  row.appendChild(el("span", "lab", rowLabel(entry)));
  const args = rowArgs(entry);
  if (args) row.appendChild(el("span", "args", args));
  if (entry.durationMs) row.appendChild(el("span", "t", formatMs(entry.durationMs)));
  row.addEventListener("click", () => {
    if (sb.selected === entry.id) { collapseDetail(); return; }
    if (sb.listEl) sb.listEl.querySelectorAll(".trc.sel").forEach((n) => n.classList.remove("sel"));
    sb.selected = entry.id;
    row.classList.add("sel");
    renderDetail(entry);
  });
  return row;
}

export function renderList(): void {
  const list = sb.listEl;
  if (!list) return;
  list.textContent = "";
  list.dataset.lastTurn = "-1";
  sb.nodeById.clear();
  sb.headerByTurn.clear();
  if (sb.selected && !sb.trace.some((e) => e.id === sb.selected)) sb.selected = null;
  if (sb.trace.length === 0) {
    list.appendChild(el("div", "trace-turn", t("web.sidebar.trace_empty")));
    return;
  }
  let shownTurn = -1;
  for (const entry of sb.trace) {
    if (entry.turn !== shownTurn) {
      shownTurn = entry.turn;
      const h = el("div", "trace-turn", t("web.sidebar.trace_turn", { n: entry.turn }));
      sb.headerByTurn.set(entry.turn, h);
      list.appendChild(h);
    }
    const row = renderRow(entry);
    sb.nodeById.set(entry.id, row);
    list.appendChild(row);
  }
  list.dataset.lastTurn = String(shownTurn);
  list.scrollTop = list.scrollHeight;
}

function append(entry: TraceEntry): TraceEntry {
  entry.id = ++sb.seq;
  entry.turn = sb.turn;
  entry.ts = Date.now();
  sb.trace.push(entry);
  while (sb.trace.length > TRACE_CAP) {
    const old = sb.trace.shift();
    if (!old) break;
    const node = sb.nodeById.get(old.id);
    if (node) { node.remove(); sb.nodeById.delete(old.id); }
    if (old.toolCallId != null) sb.callIndex.delete(old.toolCallId);
    if (!sb.trace.some((e) => e.turn === old.turn)) {
      const h = sb.headerByTurn.get(old.turn);
      if (h) { h.remove(); sb.headerByTurn.delete(old.turn); }
    }
  }
  return entry;
}

function pushRow(entry: TraceEntry): void {
  const list = sb.listEl;
  if (!list) return;
  const last = list.dataset.lastTurn ? Number(list.dataset.lastTurn) : -1;
  if (entry.turn !== last) {
    const h = el("div", "trace-turn", t("web.sidebar.trace_turn", { n: entry.turn }));
    sb.headerByTurn.set(entry.turn, h);
    list.appendChild(h);
    list.dataset.lastTurn = String(entry.turn);
  }
  const row = renderRow(entry);
  sb.nodeById.set(entry.id, row);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function replaceRow(entry: TraceEntry): void {
  const old = sb.nodeById.get(entry.id);
  const next = renderRow(entry);
  sb.nodeById.set(entry.id, next);
  if (old && old.parentNode) old.replaceWith(next);
  else if (sb.listEl) sb.listEl.appendChild(next);
  if (sb.listEl) sb.listEl.scrollTop = sb.listEl.scrollHeight;
}

function updateTextRow(entry: TraceEntry): void {
  const row = sb.nodeById.get(entry.id);
  if (!row) return;
  row.textContent = "";
  row.appendChild(el("span", "g", "✦"));
  row.appendChild(el("span", "lab", rowLabel(entry)));
  if (sb.listEl) sb.listEl.scrollTop = sb.listEl.scrollHeight;
}

// ---- public API ----

export function sidebarSessionChanged(sid: string | null | undefined): void {
  const prev = sb.el && sb.el.dataset.sid;
  if (prev === (sid || "")) return;
  if (sb.el) sb.el.dataset.sid = sid || "";
  sb.trace = [];
  sb.callIndex.clear();
  sb.textEntry = null;
  sb.turn = 0;
  sb.seq = 0;
  // Trace живой: старые ходы чужой сессии не докачиваем, только новые события.
  sb.logCursor = new Date().toISOString();
  sb.logPulling = false;
  collapseDetail();
  renderList();
}

/** Сессия, которой сейчас принадлежит сайдбар (dataset.sid), или null. */
export function sidebarSessionId(): string | null {
  return (sb.el && sb.el.dataset.sid) || null;
}

/**
 * Индикатор загрузки секции «Session» (plan/usage). Ставится на переключении
 * вкладки/новой сессии, снимается первым полным снапшотом (`applyState`).
 */
export function setSessionLoading(on: unknown): void {
  if (!sb.el) return;
  sb.el.classList.toggle("sb-loading", !!on);
  const pane = paneEl("session");
  if (pane) pane.setAttribute("aria-busy", on ? "true" : "false");
}

export function sidebarTurnEnd(turnSeq: unknown): void {
  // Серверный номер хода (реконнекты локальный счётчик не сбивают).
  sb.turn = typeof turnSeq === "number" && turnSeq > sb.turn ? turnSeq : sb.turn + 1;
  sb.textEntry = null;
}

export function sidebarTraceEvent(kind: string, data: Dict): void {
  if (!data) return;
  setTraceFace(traceFaceFor(kind, data));
  switch (kind) {
    case "tool_start": {
      const entry = append({ kind: "tool", name: data.name, args: data.args || {}, toolCallId: data.toolCallId });
      if (data.toolCallId != null) sb.callIndex.set(data.toolCallId, entry);
      pushRow(entry);
      break;
    }
    case "tool_end": {
      const entry = data.toolCallId != null ? sb.callIndex.get(data.toolCallId) : undefined;
      if (data.toolCallId != null) sb.callIndex.delete(data.toolCallId);
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
      if (!sb.textEntry) { sb.textEntry = append({ kind: "text", text: "", chars: 0 }); pushRow(sb.textEntry); }
      const chunk = data.chunk || "";
      sb.textEntry.chars += chunk.length;
      sb.textEntry.text += chunk;
      // Полный текст хода — в память (деталь покажет целиком); обрезка честная,
      // тем же капом и маркером, что у выводов тулов.
      if (sb.textEntry.text.length > MAX_OUTPUT_CHARS) {
        sb.textEntry.text = sb.textEntry.text.slice(0, MAX_OUTPUT_CHARS) +
          "\n… [truncated from " + sb.textEntry.chars + " chars]";
      }
      updateTextRow(sb.textEntry);
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
export async function sidebarPullLog(): Promise<void> {
  const sid = sb.el && sb.el.dataset.sid;
  if (!sid || sb.logPulling) return;
  sb.logPulling = true;
  try {
    let url = "/api/sessions/" + encodeURIComponent(sid) + "/log?limit=100";
    if (sb.logCursor) url += "&since=" + encodeURIComponent(sb.logCursor);
    const r = await api<{ log?: Dict[] }>(url);
    if (!r.ok || !r.data || !Array.isArray(r.data.log)) return;
    for (const e of r.data.log) {
      if (typeof e.ts === "string" && (sb.logCursor === null || e.ts > sb.logCursor)) sb.logCursor = e.ts;
      appendLogEntry(e);
    }
  } catch {
    /* best-effort supplement: Trace живёт и без докачки */
  } finally {
    sb.logPulling = false;
  }
}

function appendLogEntry(e: Dict): void {
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

function detailGroup(title: string, bodyNode: Node): HTMLElement {
  const g = el("div");
  g.appendChild(el("h5", "", title));
  g.appendChild(bodyNode);
  return g;
}
function kv(label: string, value: string): HTMLElement {
  const row = el("div", "kv");
  row.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  row.appendChild(b);
  return row;
}
function codeBlock(text: string): HTMLElement {
  const c = el("div", "code");
  c.textContent = text;
  return c;
}
function capOutput(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(0, MAX_OUTPUT_CHARS) + "\n… [truncated from " + text.length + " chars]";
}

export function renderDetail(entry: TraceEntry): void {
  const glyph = sb.detailGlyph;
  const titleEl = sb.detailTitle;
  const body = sb.detailBody;
  const detail = sb.detailEl;
  if (!detail || !glyph || !titleEl || !body) return;
  detail.hidden = false;
  const warn = isWarn(entry);
  glyph.textContent = warn ? "⚠" : entry.kind === "question" ? "?" : "◇";
  glyph.style.color = warn ? "var(--yellow)" : "var(--accent)";
  titleEl.textContent = rowLabel(entry);
  body.textContent = "";

  const meta = el("div");
  meta.appendChild(el("h5", "", t("web.sidebar.detail_metadata")));
  const d = entry.ts ? new Date(entry.ts) : null;
  if (entry.kind === "tool" || entry.kind === "tool_fail") {
    meta.appendChild(kv(t("web.sidebar.detail_status"), entry.success === false ? t("web.sidebar.detail_fail") : t("web.sidebar.detail_ok")));
    if (entry.durationMs) meta.appendChild(kv(t("web.sidebar.detail_duration"), formatMs(entry.durationMs)));
  }
  if (d) meta.appendChild(kv(t("web.sidebar.detail_time"), d.toLocaleTimeString()));
  if (entry.toolCallId) meta.appendChild(kv(t("web.sidebar.detail_tool_call"), String(entry.toolCallId)));
  if (sb.el && sb.el.dataset.sid) meta.appendChild(kv(t("web.sidebar.detail_session"), sb.el.dataset.sid));
  meta.appendChild(kv(t("web.sidebar.detail_turn"), String(entry.turn)));
  if (typeof entry.iteration === "number") meta.appendChild(kv(t("web.sidebar.detail_iteration"), String(entry.iteration)));
  body.appendChild(meta);

  if (entry.kind === "tool" || entry.kind === "tool_fail") {
    body.appendChild(detailGroup(t("web.sidebar.detail_arguments"), codeBlock(JSON.stringify(entry.args || {}, null, 2))));
    body.appendChild(detailGroup(t("web.sidebar.detail_output"), codeBlock(capOutput(entry.output))));
  } else if (entry.kind === "text") {
    body.appendChild(detailGroup(t("web.sidebar.detail_text"), codeBlock(entry.text || "")));
    loadTextProvenance(entry);
  } else if (entry.kind === "plan") {
    const list = el("div");
    (entry.steps || []).forEach((s: Dict) => {
      const mark = s.status === "done" ? "✓" : s.status === "failed" ? "✗" : s.status === "in_progress" ? "▸" : "○";
      const cls = s.status === "failed" ? "fail" : s.status === "in_progress" ? "cur" : s.status === "done" ? "done" : "";
      list.appendChild(el("div", ("plan-step " + cls).trim(), mark + " " + s.text));
    });
    body.appendChild(detailGroup(t("web.sidebar.detail_plan"), list));
  } else if (entry.kind === "question") {
    body.appendChild(detailGroup(t("web.sidebar.trace_question"), codeBlock(entry.text || "")));
  } else if (entry.kind === "error") {
    body.appendChild(detailGroup(t("web.sidebar.detail_error"), codeBlock(entry.message || "")));
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
    body.appendChild(detailGroup(title, codeBlock(entry.text || "")));
  }
}

/**
 * Привязка текста хода к session-логу: сколько assistant-сообщений в сессии,
 * их итерации и провенанс последнего LLM-вызова (модель/провайдер/токены).
 * Живой текст хода уже показан выше целиком; это — сверка с логом.
 */
async function loadTextProvenance(entry: TraceEntry): Promise<void> {
  const sid = sb.el && sb.el.dataset.sid;
  const body = sb.detailBody;
  if (!sid || !body || sb.selected !== entry.id) return;
  try {
    const r = await api<{ log?: Dict[] }>(
      "/api/sessions/" + encodeURIComponent(sid) + "/log?types=assistant,llm_usage&limit=20",
    );
    if (!r.ok || !r.data || !Array.isArray(r.data.log) || sb.selected !== entry.id) return;
    const log = r.data.log;
    const assistants = log.filter((e) => e.type === "assistant");
    const usages = log.filter((e) => e.type === "llm_usage");
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
    if (bits) body.appendChild(detailGroup(t("web.sidebar.detail_provenance"), codeBlock(bits)));
  } catch {
    /* best-effort: живой текст уже на месте */
  }
}

export function collapseDetail(): void {
  sb.selected = null;
  if (sb.detailEl) sb.detailEl.hidden = true;
  if (sb.listEl) sb.listEl.querySelectorAll(".trc.sel").forEach((n) => n.classList.remove("sel"));
}
