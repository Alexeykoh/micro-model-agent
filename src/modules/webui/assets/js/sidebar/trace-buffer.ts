// Trace buffer: append/cap bookkeeping and the reversed-list row insertion +
// per-frame stream batching. Split out of `trace.ts`.
import { el } from "../dom.js";
import { sb, TRACE_CAP, type TraceEntry } from "./state.js";
import { scheduleTrace, traceAtFreshEdge, traceFollow } from "./trace-scroll.js";
import { paintStreamRow, renderRow, turnTitle } from "./trace-rows.js";

export function append(entry: TraceEntry): TraceEntry {
  entry.id = ++sb.seq;
  entry.turn = sb.turn;
  // U15: a log-backfilled row carries the original `ts`; live rows use now.
  entry.ts =
    typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : Date.now();
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
  const first = sb.trace.find((e) => e.turn === turn);
  const h = el("div", "trace-turn", turnTitle(turn, first?.ts));
  sb.headerByTurn.set(turn, h);
  return h;
}

/**
 * Новая строка входит в начало списка. Если её ход — самый свежий (его
 * заголовок уже первый узел), строка встаёт сразу под заголовком: внутри хода
 * свежие события выше, а заголовок остаётся на месте.
 */
export function pushRow(entry: TraceEntry): void {
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

export function replaceRow(entry: TraceEntry): void {
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
    paintStreamRow(row, entry, glyph);
  }
}

export function updateTextRow(entry: TraceEntry): void {
  streamRow(entry, "✦");
}

export function updateReasonRow(entry: TraceEntry): void {
  streamRow(entry, "✻");
}

/** Ребилд списка/смена сессии: недописанные стримовые строки отбрасываются. */
export function resetStreamRows(): void {
  streamQueue.clear();
  streamFlushQueued = false;
}
