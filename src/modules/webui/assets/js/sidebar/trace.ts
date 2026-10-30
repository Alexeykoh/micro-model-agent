// Trace tab for `mma web`: live per-session event buffer with master-detail
// expansion, plus the log-supplement fetch. Split out of `sidebar.js`.
import { el } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { labelOf, categoryOf, argText, formatMs } from "../format.js";
import type { Dict } from "../core/store/types.js";
import {
  sb,
  paneEl,
  TRACE_CAP,
  TRACE_GATE_NOTICE_MS,
  MAX_OUTPUT_CHARS,
  type TraceEntry,
} from "./state.js";
import { isWarn, phaseLabel, rowLabel, gateBreakdown } from "./trace-labels.js";
import { renderDetail } from "./trace-detail.js";
import { sidebarSubagentsSessionChanged } from "./subagents.js";
import { resetTraceScroll, scheduleTrace, traceAtFreshEdge, traceFollow } from "./trace-scroll.js";

export { renderDetail } from "./trace-detail.js";

function catClass(kind: string, name: string): string {
  if (kind === "tool" || kind === "tool_fail") return categoryOf(name);
  if (kind === "phase") return "phase";
  if (kind === "reasoning") return "reasoning";
  return "meta";
}

function rowArgs(entry: TraceEntry): string {
  if (entry.kind === "text" || entry.kind === "reasoning" || entry.kind === "phase") return "";
  // У `gate_timing` вся суть уже в подписи строки — разбивка живёт в детали.
  if (entry.kind === "gate") return "";
  if (entry.kind === "plan") {
    const idx = typeof entry.currentIndex === "number" ? entry.currentIndex : 0;
    const total = Array.isArray(entry.steps) ? entry.steps.length : 0;
    if (!total) return "";
    return t("web.rail.step_of", { cur: Math.min(idx + 1, total), total });
  }
  if (entry.kind === "question") return entry.text || "";
  // Диагностические строки несут смысл в одной строке (статус/лог/ретракт/
  // индекс/критик/компакция/проба/usage/аудит/claim/вывод).
  if (
    entry.text &&
    typeof entry.text === "string" &&
    entry.kind !== "tool" &&
    entry.kind !== "tool_fail"
  ) {
    const line =
      entry.text
        .split("\n")
        .map((l: string) => l.trim())
        .find((l: string) => l.length > 0) || "";
    return line.slice(0, 160);
  }
  return argText(entry.args);
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
    if (sb.selected === entry.id) {
      collapseDetail();
      return;
    }
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
  sb.nodeById.clear();
  sb.headerByTurn.clear();
  streamQueue.clear();
  streamFlushQueued = false;
  if (sb.selected && !sb.trace.some((e) => e.id === sb.selected)) sb.selected = null;
  if (sb.trace.length === 0) {
    list.appendChild(el("div", "trace-turn", t("web.sidebar.trace_empty")));
    resetTraceScroll();
    return;
  }
  // Свежие строки — сверху: обходим буфер с конца (новое первым). Заголовок
  // хода ставится перед строками своего хода, поэтому ход не «разрезан» на два
  // блока: самый свежий ход — первым, внутри хода свежие события выше.
  let shownTurn: number | null = null;
  for (let i = sb.trace.length - 1; i >= 0; i--) {
    const entry = sb.trace[i];
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
  resetTraceScroll();
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
    if (node) {
      node.remove();
      sb.nodeById.delete(old.id);
    }
    if (old.toolCallId != null) sb.callIndex.delete(old.toolCallId);
    if (!sb.trace.some((e) => e.turn === old.turn)) {
      const h = sb.headerByTurn.get(old.turn);
      if (h) {
        h.remove();
        sb.headerByTurn.delete(old.turn);
      }
    }
  }
  return entry;
}

function turnHeader(turn: number): HTMLElement {
  const h = el("div", "trace-turn", t("web.sidebar.trace_turn", { n: turn }));
  sb.headerByTurn.set(turn, h);
  return h;
}

/**
 * Новая строка входит в начало списка. Если её ход — самый свежий (его
 * заголовок уже первый узел), строка встаёт сразу под заголовком: внутри хода
 * свежие события выше, а заголовок остаётся на месте.
 */
function pushRow(entry: TraceEntry): void {
  const list = sb.listEl;
  if (!list) return;
  const pinned = traceAtFreshEdge();
  // Пустая лента показывает заглушку; первая настоящая строка её вытесняет —
  // иначе «no events yet» остаётся в самом низу перевёрнутого списка.
  if (sb.trace.length === 1 && list.childElementCount === 1) list.textContent = "";
  const row = renderRow(entry);
  sb.nodeById.set(entry.id, row);
  const head = list.firstElementChild as HTMLElement | null;
  if (head && head === sb.headerByTurn.get(entry.turn)) {
    list.insertBefore(row, head.nextSibling);
  } else {
    list.insertBefore(row, list.firstChild);
    list.insertBefore(turnHeader(entry.turn), row);
  }
  traceFollow(pinned);
}

function replaceRow(entry: TraceEntry): void {
  const old = sb.nodeById.get(entry.id);
  if (!old || !old.parentNode) {
    pushRow(entry);
    return;
  }
  const pinned = traceAtFreshEdge();
  const next = renderRow(entry);
  sb.nodeById.set(entry.id, next);
  old.replaceWith(next);
  traceFollow(pinned);
}

// Стриминговые строки обновляются пачкой: один пересчёт и один скролл на кадр,
// а не на каждый чанк текста (было `scrollTop = scrollHeight` на токен).
const streamQueue = new Map<number, { entry: TraceEntry; glyph: string }>();
let streamFlushQueued = false;

function streamRow(entry: TraceEntry, glyph: string): void {
  streamQueue.set(entry.id, { entry, glyph });
  if (!streamFlushQueued) {
    streamFlushQueued = true;
    scheduleTrace(flushStreamRows);
  }
  traceFollow(traceAtFreshEdge());
}

function flushStreamRows(): void {
  streamFlushQueued = false;
  if (streamQueue.size === 0) return;
  const items = [...streamQueue.values()];
  streamQueue.clear();
  for (const { entry, glyph } of items) {
    const row = sb.nodeById.get(entry.id);
    if (!row) continue;
    row.textContent = "";
    row.appendChild(el("span", "g", glyph));
    row.appendChild(el("span", "lab", rowLabel(entry)));
  }
}

function updateTextRow(entry: TraceEntry): void {
  streamRow(entry, "✦");
}

function updateReasonRow(entry: TraceEntry): void {
  streamRow(entry, "✻");
}

// ---- public API ----

export function sidebarSessionChanged(sid: string | null | undefined): void {
  const prev = sb.el && sb.el.dataset.sid;
  if (prev === (sid || "")) return;
  if (sb.el) sb.el.dataset.sid = sid || "";
  sb.trace = [];
  sb.callIndex.clear();
  sb.textEntry = null;
  sb.reasonEntry = null;
  sb.turn = 0;
  sb.seq = 0;
  // Trace живой: старые ходы чужой сессии не докачиваем, только новые события.
  sb.logCursor = new Date().toISOString();
  sb.logPulling = false;
  collapseDetail();
  renderList();
  sidebarSubagentsSessionChanged();
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
  sb.reasonEntry = null;
}

export function sidebarTraceEvent(kind: string, data: Dict): void {
  if (!data) return;
  switch (kind) {
    case "tool_start": {
      const entry = append({
        kind: "tool",
        name: data.name,
        args: data.args || {},
        toolCallId: data.toolCallId,
      });
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
          name: data.name,
          args: data.args || {},
          toolCallId: data.toolCallId,
          success: data.success !== false,
          durationMs: data.durationMs,
          output: data.output || "",
        });
        pushRow(e2);
      }
      break;
    }
    case "phase":
      if (data.phase !== "done") pushRow(append({ kind: "phase", phase: data.phase }));
      break;
    case "plan":
      pushRow(
        append({
          kind: "plan",
          steps: Array.isArray(data.steps) ? data.steps : [],
          currentIndex: typeof data.currentIndex === "number" ? data.currentIndex : 0,
        }),
      );
      break;
    case "question":
      pushRow(append({ kind: "question", text: data.question || data.text || "" }));
      break;
    case "text": {
      if (!sb.textEntry) {
        sb.textEntry = append({ kind: "text", text: "", chars: 0 });
        pushRow(sb.textEntry);
      }
      const chunk = data.chunk || "";
      sb.textEntry.chars += chunk.length;
      sb.textEntry.text += chunk;
      // Полный текст хода — в память (деталь покажет целиком); обрезка честная,
      // тем же капом и маркером, что у выводов тулов.
      if (sb.textEntry.text.length > MAX_OUTPUT_CHARS) {
        sb.textEntry.text =
          sb.textEntry.text.slice(0, MAX_OUTPUT_CHARS) +
          "\n… [truncated from " +
          sb.textEntry.chars +
          " chars]";
      }
      updateTextRow(sb.textEntry);
      break;
    }
    case "reasoning": {
      if (!sb.reasonEntry) {
        sb.reasonEntry = append({ kind: "reasoning", text: "", chars: 0 });
        pushRow(sb.reasonEntry);
      }
      const chunk = data.chunk || "";
      sb.reasonEntry.chars += chunk.length;
      sb.reasonEntry.text += chunk;
      if (sb.reasonEntry.text.length > MAX_OUTPUT_CHARS) {
        sb.reasonEntry.text =
          sb.reasonEntry.text.slice(0, MAX_OUTPUT_CHARS) +
          "\n… [truncated from " +
          sb.reasonEntry.chars +
          " chars]";
      }
      updateReasonRow(sb.reasonEntry);
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
      // Отзыв штатный, но обязан быть привязан к вердикту: source/reason/
      // iteration стыкуют строку с `critic_verdict`/`claim_retry` в логе.
      pushRow(
        append({
          kind: "retract",
          text: data.reason || data.label || "",
          source: data.source || "",
          reason: data.reason || "",
          iteration: typeof data.iteration === "number" ? data.iteration : undefined,
          verdict: data.verdict || "",
        }),
      );
      break;
    case "index": {
      const stats =
        data.stats && typeof data.stats === "object"
          ? Object.entries(data.stats)
              .map(([k, v]) => k + ": " + v)
              .join(", ")
          : "";
      pushRow(append({ kind: "index", phase: data.phase || "", text: stats }));
      break;
    }
    default:
      break;
  }
}

/**
 * Докачка диагностических событий из session-лога (критик, компакция,
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
      if (typeof e.ts === "string" && (sb.logCursor === null || e.ts > sb.logCursor))
        sb.logCursor = e.ts;
      appendLogEntry(e);
    }
  } catch {
    /* best-effort supplement: Trace живёт и без докачки */
  } finally {
    sb.logPulling = false;
  }
}

export function appendLogEntry(e: Dict): void {
  if (!e || typeof e.type !== "string") return;
  switch (e.type) {
    case "gate_timing": {
      // A15: сколько ход простоял в гейтах. Шум не плодим — только заметные
      // простои; строка связывает «ответ уже виден» с пост-обработкой.
      const ms = typeof e.duration === "number" ? e.duration : 0;
      if (ms < TRACE_GATE_NOTICE_MS) break;
      const gates = e.gates && typeof e.gates === "object" ? e.gates : {};
      pushRow(
        append({
          kind: "gate",
          duration: ms,
          gates,
          iteration: e.iteration,
          text: gateBreakdown(ms, gates),
        }),
      );
      break;
    }
    case "critic_check":
      pushRow(
        append({ kind: "critic", status: "check", text: e.content || "", iteration: e.iteration }),
      );
      break;
    case "critic_verdict":
      pushRow(
        append({
          kind: "critic",
          status: e.status || "",
          text: e.content || "",
          iteration: e.iteration,
        }),
      );
      break;
    case "critic_escalation":
      pushRow(
        append({
          kind: "critic",
          status: "escalation",
          text: e.content || "",
          iteration: e.iteration,
        }),
      );
      break;
    case "critic_error":
      pushRow(
        append({
          kind: "critic",
          status: "error",
          text: e.content || e.error || "",
          iteration: e.iteration,
        }),
      );
      break;
    case "compaction":
      pushRow(append({ kind: "compaction", text: e.content || "", iteration: e.iteration }));
      break;
    case "context_probe":
      pushRow(append({ kind: "probe", text: e.content || "" }));
      break;
    case "llm_usage": {
      const toks =
        typeof e.totalTokens === "number"
          ? e.totalTokens
          : (e.promptTokens || 0) + (e.completionTokens || 0);
      const who = [e.model || e.provider, toks ? toks + " tok" : ""].filter(Boolean).join(" · ");
      pushRow(append({ kind: "usage", text: who, iteration: e.iteration }));
      break;
    }
    case "audit":
      pushRow(append({ kind: "audit", text: e.content || "", iteration: e.iteration }));
      break;
    case "claim_retry":
      pushRow(
        append({
          kind: "claim",
          subkind: e.kind || "",
          text: e.content || "",
          iteration: e.iteration,
        }),
      );
      break;
    case "output":
      pushRow(append({ kind: "output", text: e.content || "", iteration: e.iteration }));
      break;
    default:
      break;
  }
}

export function collapseDetail(): void {
  sb.selected = null;
  if (sb.detailEl) sb.detailEl.hidden = true;
  if (sb.listEl) sb.listEl.querySelectorAll(".trc.sel").forEach((n) => n.classList.remove("sel"));
}
