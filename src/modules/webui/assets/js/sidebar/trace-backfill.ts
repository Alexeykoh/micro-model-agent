// Log backfill for the Trace tab: incremental pull of `session.jsonl` records
// that have no dedicated SSE producer. Split out of `trace.ts`.
import { api } from "../api.js";
import type { Dict } from "../core/store/types.js";
import { sb } from "./state.js";
import { append, pushRow } from "./trace-buffer.js";
import { appendLogEntry as appendLogRow } from "./trace-log.js";

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
  // U15: keep the log's own timestamp, so a backfilled historical trace shows
  // when events actually happened instead of "all at the moment of opening".
  const raw = typeof e.ts === "string" ? Date.parse(e.ts) : typeof e.ts === "number" ? e.ts : NaN;
  const appendAt = (entry: Dict): Dict =>
    Number.isFinite(raw) ? append({ ...entry, ts: raw }) : append(entry);
  appendLogRow(e, { append: appendAt, pushRow });
}
