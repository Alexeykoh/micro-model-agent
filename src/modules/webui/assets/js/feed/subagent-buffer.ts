// Клиентские буферы прогонов субагентов: дедуп по `seq`, мета, LRU, статусы.
// Вынесено из `feed/subagent.ts` (правило 6), чтобы вид и поток событий не
// разрастались в один файл.
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { formatMs } from "../format.js";
import { toolState, type FaceState } from "../loader.js";

const MAX_RUNS = 40;
export const MAX_EVENTS = 1000;

/** Буфер прогона: метаданные, wire-события и последний `seq`. */
export interface RunBuf {
  meta: Dict;
  events: Dict[];
  seq: number;
}

/** Буферы по runId (общие для вкладок; кап — LRU по вставке). */
const runs = new Map<string, RunBuf>();

/** Буфер прогона (создаётся лениво). */
export function buf(runId: string): RunBuf {
  let b = runs.get(runId);
  if (!b) {
    b = { meta: {}, events: [], seq: 0 };
    runs.set(runId, b);
    while (runs.size > MAX_RUNS) {
      const first = runs.keys().next();
      if (first.done) break;
      runs.delete(first.value);
    }
  }
  return b;
}

/** Собирает мету из событий (start/end важнее промежуточных kind). */
export function metaFor(events: Dict[], fallback: Dict): Dict {
  const start = events.find((e) => e.kind === "start");
  const end = [...events].reverse().find((e) => e.kind === "end");
  return { ...(start || {}), ...(fallback || {}), ...(end || {}) };
}

/** Принимает живое SSE-событие; false — дубль/мусор (не рендерим). */
export function mergeEvent(d: Dict): boolean {
  if (!d || typeof d.runId !== "string") return false;
  const b = buf(d.runId);
  const seq = Number(d.seq || 0);
  if (seq > 0 && b.events.some((e) => Number(e.seq || 0) === seq)) return false;
  if (b.events.length >= MAX_EVENTS) return false;
  b.events.push(d);
  b.seq = Math.max(b.seq, seq);
  b.meta = metaFor(b.events, { ...b.meta, ...d });
  if (d.kind === "start" && !b.meta.parentSessionId && d.sessionId) {
    // fallback для усечённых событий: сессия-владелец = адресат SSE
    b.meta.parentSessionId = d.sessionId;
  }
  return true;
}

/** Мержит снимок REST в буфер (по `seq`, без дублей). Возвращает runId. */
export function mergeSnapshot(snap: Dict): string {
  const id = String(snap.runId || "");
  if (!id) return "";
  const b = buf(id);
  const known = new Set(b.events.map((e) => Number(e.seq || 0)));
  for (const ev of Array.isArray(snap.events) ? snap.events : []) {
    const seq = Number(ev.seq || 0);
    if (!known.has(seq)) b.events.push(ev);
  }
  b.events.sort((a, c) => Number(a.seq || 0) - Number(c.seq || 0));
  b.meta = metaFor(b.events, { ...b.meta, ...snap });
  return id;
}

/** Прогоны сессии, известные клиенту (для чипов), старые первыми. */
export function sessionRuns(sessionId: string): Dict[] {
  const out: Dict[] = [];
  for (const b of runs.values()) {
    if (b.meta.parentSessionId === sessionId) out.push(b.meta);
  }
  return out.sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0));
}

/**
 * Состояние MMART для прогона: статус важнее последнего события, иначе — по
 * последнему событию (текст → type, тул → его категория, ожидание → think).
 */
export function runFaceState(b: RunBuf): FaceState {
  const status = b.meta.status;
  if (status === "done") return "done";
  if (status === "failed") return "error";
  if (status === "interrupted") return "stop";
  for (let i = b.events.length - 1; i >= 0; i--) {
    const ev = b.events[i];
    switch (ev.kind) {
      case "text":
        return "type";
      case "reasoning":
      case "note":
      case "phase":
        return "think";
      case "tool_end":
        return ev.success === false ? "warn" : "think";
      case "tool_start":
        return toolState(String(ev.tool || ""));
      case "start":
        return "think";
      default:
        break;
    }
  }
  return "think";
}

/** Текст статуса в шапке (running показывает секунды от старта). */export function statusText(meta: Dict, started: number, now = Date.now()): string {
  const status = meta.status || "running";
  if (status === "running") {
    const secs = Math.max(0, Math.round((now - started) / 1000));
    return t("web.subagent.running") + (secs ? " · " + secs + "s" : "");
  }
  const key =
    status === "done"
      ? "web.subagent.done"
      : status === "interrupted"
        ? "web.subagent.interrupted"
        : "web.subagent.failed";
  return t(key) + (typeof meta.durationMs === "number" ? " · " + formatMs(meta.durationMs) : "");
}
