/**
 * `GET /api/sessions/:id/history` — a normalized, renderable transcript.
 *
 * The session manager's `session.jsonl` log is the source of truth (it already
 * carries user/assistant/reasoning text and tool lifecycle events in order).
 * Logs written by older builds may lack it, so we fall back to the message
 * history (`history.jsonl` / rotated `.jsonl.gz`) for user/assistant/tool text.
 *
 * The browser gets a flat `HistoryEntry[]` in chronological order, capped to the
 * last `state.historyTail` entries so a long session cannot blow up the payload.
 * Secrets are redacted with the same point-redactor the SSE path uses; the log
 * itself is already sanitized on write, but args/text are scrubbed again here so
 * the invariant holds regardless of the producer.
 *
 * Auth + same-origin are enforced upstream in `server.ts`.
 */
import type { ServerResponse } from "node:http";
import type { SessionLogEntry } from "../../modules/session/store";
import type { SessionMessage } from "../../modules/session/types";
import { getMessageText } from "../../llm/provider";
import { redactContextSecrets } from "../../core/agent/context-log";
import { stripAnsi } from "../../ui/line-math";
import { scrubToolArgs } from "./forward";
import { sendJson } from "./util";
import type { WebUiState } from "./state";

export type HistoryKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "system"
  | "plan"
  | "context"
  | "error";

/** Normalized entry the browser renders; `kind` selects the visual form. */
export interface HistoryEntry {
  ts: string;
  kind: HistoryKind;
  text?: string;
  toolCallId?: string;
  name?: string;
  tool?: string;
  args?: Record<string, unknown>;
  success?: boolean;
  duration?: number;
}

function scrub(text: string | undefined): string | undefined {
  return text ? stripAnsi(redactContextSecrets(text)) : undefined;
}

/** Map one raw log entry to the wire shape, or `null` for internal-only types. */
function mapLogEntry(e: SessionLogEntry): HistoryEntry | null {
  switch (e.type) {
    case "user":
      return { ts: e.ts, kind: "user", text: scrub(e.content) };
    case "assistant":
      return { ts: e.ts, kind: "assistant", text: scrub(e.content) };
    case "reasoning":
      return { ts: e.ts, kind: "reasoning", text: scrub(e.content) };
    case "tool_call":
      return {
        ts: e.ts,
        kind: "tool_call",
        toolCallId: e.tool_call_id,
        name: e.tool,
        args: scrubToolArgs(e.args ?? {}),
      };
    case "tool_result":
      return {
        ts: e.ts,
        kind: "tool_result",
        toolCallId: e.tool_call_id,
        tool: e.tool,
        success: e.success ?? false,
        duration: e.duration,
      };
    case "plan":
      return { ts: e.ts, kind: "plan", text: scrub(e.content) };
    case "context":
      return { ts: e.ts, kind: "context", text: scrub(e.content) };
    case "error":
      return { ts: e.ts, kind: "error", text: scrub(e.content) };
    case "system":
      return { ts: e.ts, kind: "system", text: scrub(e.content) };
    default:
      // tool_defs / llm_usage / session_start / baseline_typecheck /
      // reasoning_control / context_probe / output / compaction / audit / moe_*
      // are not useful in a chat transcript.
      return null;
  }
}

/** Best-effort transcript from `history.jsonl` when `session.jsonl` is absent. */
function fromMessages(messages: SessionMessage[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const m of messages) {
    const text = scrub(getMessageText(m.content));
    if (m.role === "user") {
      out.push({ ts: m.timestamp, kind: "user", text });
    } else if (m.role === "assistant") {
      if (text) out.push({ ts: m.timestamp, kind: "assistant", text });
    } else if (m.role === "tool") {
      out.push({
        ts: m.timestamp,
        kind: "tool_result",
        toolCallId: m.tool_call_id,
        tool: m.name,
        success: true,
      });
    } else if (m.role === "system" && text) {
      out.push({ ts: m.timestamp, kind: "system", text });
    }
  }
  return out;
}

/** Normalize a raw log (or history fallback) and cap to the last `tail` entries. */
export function normalizeHistory(
  entries: SessionLogEntry[],
  tail: number,
  fallback: SessionMessage[] = [],
): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const e of entries) {
    const mapped = mapLogEntry(e);
    if (mapped) out.push(mapped);
  }
  const source = out.length > 0 ? out : fromMessages(fallback);
  return tail > 0 ? source.slice(-tail) : source;
}

/** `GET /api/sessions/:id/history` — 200 transcript, 404 unknown, 503 unwired. */
export function handleSessionHistory(res: ServerResponse, id: string, s: WebUiState): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  const manager = s.sessionManager;
  if (!id || !manager.get(id)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  let log: SessionLogEntry[] = [];
  let messages: SessionMessage[] = [];
  try {
    log = manager.loadSessionLog?.(id) ?? [];
    if (log.length === 0) messages = manager.getHistory?.(id) ?? [];
  } catch {
    // Unreadable/encrypted-mismatch session: answer an empty transcript rather
    // than failing the whole page load.
    log = [];
    messages = [];
  }
  sendJson(res, 200, { id, history: normalizeHistory(log, s.historyTail, messages) });
}
