// `GET /api/sessions/:id/history` — нормализованный рендеримый транскрипт.
//
// Источник правды — `session.jsonl` менеджера (уже несёт по порядку текст
// user/assistant/reasoning и события жизни тулов). Логам старых сборок его
// может не хватать — фолбэк на историю сообщений (`history.jsonl` / ротированные
// `.jsonl.gz`) для текста user/assistant/tool.
//
// Браузер получает плоский `HistoryEntry[]` хронологически, капнутый хвостом
// `state.historyTail`, чтобы длинная сессия не раздула пейлоад. Секреты — тем же
// точечным редактором, что в SSE-пути; сам лог уже санитизирован на записи, но
// args/текст скрабим повторно, чтобы инвариант держался от любого продюсера.
//
// Auth и same-origin — выше в `server.ts`.
import type { ServerResponse } from "node:http";
import type { SessionLogEntry } from "../../modules/session/store";
import type { SessionMessage } from "../../modules/session/types";
import { getMessageText } from "../../llm/provider";
import { redactContextSecrets } from "../../core/agent/context-log";
import { stripAnsi } from "../../ui/line-math";
import { scrubToolArgs } from "./forward";
import { sendJson } from "./util";
import type { WebUiState } from "./state";

/** Вид записи истории. */
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

/** Нормализованная запись для браузера; `kind` выбирает визуальную форму. */
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

/** Маппит одну сырую запись лога в wire-форму; `null` — внутренним типам. */
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
    case "error":
      return { ts: e.ts, kind: "error", text: scrub(e.content) };
    default:
      // system (текст системного промпта из slog.logSystem) и context
      // (снапшоты "context snapshot at session start") — внутренняя
      // диагностика: в живом SSE-потоке их нет, а в истории после reload
      // они всплывали шумом поверх чата. Смотрятся в Trace (/api/.../log).
      // tool_defs / llm_usage / session_start / baseline_typecheck /
      // reasoning_control / context_probe / output / compaction / audit / moe_*
      // в чат-транскрипте бесполезны.
      return null;
  }
}

/** Best-effort транскрипт из `history.jsonl`, когда `session.jsonl` отсутствует. */
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
    } else if (m.role === "system") {
      // Системный промпт из history.jsonl — не чат, в транскрипт не идёт.
      continue;
    }
  }
  return out;
}

/** Нормализует сырой лог (или фолбэк истории) и режет до хвоста `tail`. */
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

/** `GET /api/sessions/:id/history` — 200 транскрипт, 404 чужой, 503 неввязанный. */
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
    // Нечитаемая сессия (в т.ч. мисматч шифрования): пустой транскрипт вместо провала всей страницы.
    log = [];
    messages = [];
  }
  sendJson(res, 200, { id, history: normalizeHistory(log, s.historyTail, messages) });
}
