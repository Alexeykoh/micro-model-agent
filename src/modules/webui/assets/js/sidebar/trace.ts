// Trace tab for `mma web`: live per-session event buffer with master-detail
// expansion, plus the log-supplement fetch. Split out of `sidebar.js`.
// Row rendering lives in `trace-rows.ts`, buffer/stream batching in
// `trace-buffer.ts`, log backfill in `trace-backfill.ts`.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { sb, paneEl, MAX_OUTPUT_CHARS } from "./state.js";
import { renderRow, turnTitle, collapseDetail } from "./trace-rows.js";
import {
  append,
  pushRow,
  replaceRow,
  resetStreamRows,
  updateTextRow,
  updateReasonRow,
} from "./trace-buffer.js";
import { sidebarSubagentsSessionChanged } from "./subagents.js";
import { sidebarSecuritySessionChanged } from "./security.js";
import { resetTraceScroll } from "./trace-scroll.js";
import { rememberRequest, clearRequestMemo } from "./request-popup.js";
import { sidebarPullLog, appendLogEntry } from "./trace-backfill.js";

export { renderDetail } from "./trace-detail.js";
export { collapseDetail, sidebarPullLog, appendLogEntry };

export function renderList(): void {
  const list = sb.listEl;
  if (!list) return;
  list.textContent = "";
  sb.nodeById.clear();
  sb.headerByTurn.clear();
  resetStreamRows();
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
      const h = el("div", "trace-turn", turnTitle(entry.turn, entry.ts));
      sb.headerByTurn.set(entry.turn, h);
      list.appendChild(h);
    }
    const row = renderRow(entry);
    sb.nodeById.set(entry.id, row);
    list.appendChild(row);
  }
  resetTraceScroll();
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
  // Догоняем историю сессии (U3): курсор с начала лога, а не «сейчас».
  // Раньше открытая старая сессия показывала «событий пока нет».
  sb.logCursor = null;
  sb.logPulling = false;
  collapseDetail();
  renderList();
  void sidebarPullLog();
  sidebarSubagentsSessionChanged();
  sidebarSecuritySessionChanged();
  clearRequestMemo();
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
    case "llm_request": {
      const request = data.request;
      if (!request || typeof request !== "object") break;
      // Последний снимок — для перехода из бейджа DLP (U21).
      rememberRequest(request);
      pushRow(append({ kind: "request", request }));
      break;
    }
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
