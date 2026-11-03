// Rendering of a single Trace row: glyph, label, args, duration and stamp, plus
// the row click contract (detail pane / request popup). Split out of `trace.ts`.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { categoryOf, argText, formatMs } from "../format.js";
import type { Dict } from "../core/store/types.js";
import { sb, type TraceEntry } from "./state.js";
import { isWarn, rowLabel } from "./trace-labels.js";
import { renderDetail } from "./trace-detail.js";
import { openRequestDialog } from "./request-popup.js";

function catClass(kind: string, name: string): string {
  if (kind === "tool" || kind === "tool_fail") return categoryOf(name);
  if (kind === "phase") return "phase";
  if (kind === "reasoning") return "reasoning";
  return "meta";
}

/** Wall-clock `HH:MM:SS` for a trace row (U15). */
function clock(ts: unknown): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Seconds since the first row of the same turn (`+2.4s`). */
function turnOffset(entry: TraceEntry): string {
  const first = sb.trace.find((e) => e.turn === entry.turn);
  const start = typeof first?.ts === "number" ? first.ts : entry.ts;
  if (typeof entry.ts !== "number" || typeof start !== "number") return "";
  return `+${((entry.ts - start) / 1000).toFixed(1)}s`;
}

/** Right-hand time cell; `title` carries the offset inside the turn. */
function appendStamp(row: HTMLElement, entry: TraceEntry): void {
  const text = clock(entry.ts);
  if (!text) return;
  const stamp = el("span", "ts", text);
  const offset = turnOffset(entry);
  if (offset) stamp.title = offset;
  row.appendChild(stamp);
}

/** Turn header carries the wall-clock start of that turn. */
export function turnTitle(turn: number, ts?: unknown): string {
  const label = t("web.sidebar.trace_turn", { n: turn });
  const time = clock(ts);
  return time ? `${label} · ${time}` : label;
}

function rowArgs(entry: TraceEntry): string {
  if (entry.kind === "text" || entry.kind === "reasoning" || entry.kind === "phase") return "";
  // У `gate_timing` вся суть уже в подписи строки — разбивка живёт в детали.
  if (entry.kind === "gate") return "";
  if (entry.kind === "request") {
    const req = entry.request;
    return req && typeof req === "object" ? String((req as Dict).model || "") : "";
  }
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

export function renderRow(entry: TraceEntry): HTMLElement {
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
  appendStamp(row, entry);
  row.addEventListener("click", () => {
    // Снимок исходящего запроса (U20) — не деталь строки, а поп-ап: там
    // system/messages/tools целиком, в узкую панель они не влезают.
    if (entry.kind === "request") {
      openRequestDialog(entry.request);
      return;
    }
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

/** Repaint a streamed row in place (text/reasoning chunks share one shape). */
export function paintStreamRow(row: HTMLElement, entry: TraceEntry, glyph: string): void {
  row.textContent = "";
  row.appendChild(el("span", "g", glyph));
  row.appendChild(el("span", "lab", rowLabel(entry)));
  appendStamp(row, entry);
}

export function collapseDetail(): void {
  sb.selected = null;
  if (sb.detailEl) sb.detailEl.hidden = true;
  if (sb.listEl) sb.listEl.querySelectorAll(".trc.sel").forEach((n) => n.classList.remove("sel"));
}
