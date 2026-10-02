// `GET /api/sessions/:id/log` — диагностический хвост `session.jsonl` для Trace.
//
// Чат-транскрипт (`history-api.ts`) сознательно дропает служебные типы
// (usage/probe/compaction/audit/critic/moe/claim_retry/output) — а для разбора
// полёта они и нужны. Этот роут отдаёт их сырьём (whitelist полей, скраб
// секретов/ANSI), с фильтром `?types=a,b`, курсором `?since=<ts>` и капом
// `?limit=N`. Trace докачивает инкремент на каждый `turn_end` и рисует строки
// без новых SSE-продюсеров: данные уже лежат в логе с `iteration`.
//
// Auth и same-origin — выше в `server.ts`.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionLogEntry } from "../../session/store";
import { redactContextSecrets } from "../../../core/agent/context-log";
import { stripAnsi } from "../../../ui/line-math";
import { sendJson } from "../util";
import type { WebUiState } from "../state";

/** Диагностические типы по умолчанию (живой Trace докачивает именно их). */
export const TRACE_LOG_TYPES = [
  "assistant",
  "llm_usage",
  "compaction",
  "context_probe",
  "audit",
  "moe_plan",
  "moe_subtask",
  "moe_replan",
  "moe_verify",
  "output",
  "critic_check",
  "critic_verdict",
  "critic_escalation",
  "claim_retry",
] as const;

/** Всё, что роут вообще готов отдать (закрытый список, не `*`). */
const ALLOWED_TYPES = new Set<string>([
  ...TRACE_LOG_TYPES,
  "tool_call",
  "tool_result",
  "user",
  "error",
  "context",
]);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function scrub(text: string | undefined): string | undefined {
  return text ? stripAnsi(redactContextSecrets(text)) : undefined;
}

/** Строковые поля с именами 1:1 в `SessionLogEntry` и `LogTailEntry`. */
type StrKey = "status" | "kind" | "provider" | "model" | "tool" | "title" | "subtaskId" | "expertTag";
/** Числовые поля с именами 1:1. */
type NumKey =
  | "iteration"
  | "promptTokens"
  | "completionTokens"
  | "totalTokens"
  | "duration"
  | "cycle";
const STR_FIELDS: readonly StrKey[] = [
  "status",
  "kind",
  "provider",
  "model",
  "tool",
  "title",
  "subtaskId",
  "expertTag",
];
const NUM_FIELDS: readonly NumKey[] = [
  "iteration",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "duration",
  "cycle",
];

/** Нужные Trace поля записи (whitelist — никаких args/окружений наружу). */
export interface LogTailEntry {
  ts: string;
  type: string;
  iteration?: number;
  content?: string;
  status?: string;
  kind?: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  tool?: string;
  toolCallId?: string;
  success?: boolean;
  duration?: number;
  title?: string;
  subtaskId?: string;
  expertTag?: string;
  cycle?: number;
}

function copyStr(out: LogTailEntry, e: SessionLogEntry, f: StrKey): void {
  const v = e[f];
  if (typeof v === "string") out[f] = v;
}

function copyNum(out: LogTailEntry, e: SessionLogEntry, f: NumKey): void {
  const v = e[f];
  if (typeof v === "number") out[f] = v;
}

function pick(e: SessionLogEntry): LogTailEntry {
  const out: LogTailEntry = { ts: e.ts, type: e.type };
  for (const f of STR_FIELDS) copyStr(out, e, f);
  for (const f of NUM_FIELDS) copyNum(out, e, f);
  if (typeof e.success === "boolean") out.success = e.success;
  // Единственное поле с разным именем: `tool_call_id` в логе → `toolCallId` на wire.
  if (typeof e.tool_call_id === "string") out.toolCallId = e.tool_call_id;
  const text = scrub(e.content ?? e.summary ?? e.message);
  if (text !== undefined) out.content = text;
  return out;
}

function parseQuery(url: string | undefined): URLSearchParams {
  try {
    return new URL(url ?? "", "http://127.0.0.1").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Фильтрует лог по типам/курсору и режет до лимита (чисто, тестируется без сервера). */
export function tailSessionLog(
  entries: SessionLogEntry[],
  opts: { types?: string[]; since?: string; limit?: number } = {},
): LogTailEntry[] {
  const types = opts.types && opts.types.length > 0 ? new Set(opts.types) : new Set(TRACE_LOG_TYPES);
  const since = opts.since ? Date.parse(opts.since) : NaN;
  const limit = Math.min(
    Math.max(opts.limit ?? DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const out: LogTailEntry[] = [];
  for (const e of entries) {
    if (!ALLOWED_TYPES.has(e.type) || !types.has(e.type)) continue;
    if (!Number.isNaN(since)) {
      const ts = Date.parse(e.ts);
      if (Number.isNaN(ts) || ts <= since) continue;
    }
    out.push(pick(e));
  }
  return out.slice(-limit);
}

/** `GET /api/sessions/:id/log` — 200 хвост, 404 чужая, 503 неввязанная. */
export function handleSessionLog(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  s: WebUiState,
): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  const manager = s.sessionManager;
  if (!id || !manager.get(id)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const q = parseQuery(req.url);
  const types = (q.get("types") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => ALLOWED_TYPES.has(t));
  // Осторожно: Number(null) === 0 — отсутствующий limit давал бы slice(-1).
  const rawLimit = q.get("limit");
  const limit = rawLimit === null || rawLimit.trim() === "" ? undefined : Number(rawLimit);
  let log: SessionLogEntry[] = [];
  try {
    log = manager.loadSessionLog?.(id) ?? [];
  } catch {
    // Нечитаемая сессия: пустой хвост вместо провала всей страницы.
    log = [];
  }
  sendJson(res, 200, {
    id,
    log: tailSessionLog(log, {
      types,
      since: q.get("since") ?? undefined,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    }),
  });
}
