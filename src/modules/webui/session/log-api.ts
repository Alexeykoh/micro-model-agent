// `GET /api/sessions/:id/log` — диагностический хвост `session.jsonl` для Trace.
//
// Чат-транскрипт (`history-api.ts`) сознательно дропает служебные типы
// (usage/probe/compaction/audit/critic/claim_retry/output) — а для разбора
// полёта они и нужны. Этот роут отдаёт их сырьём (whitelist полей, скраб
// секретов/ANSI), с фильтром `?types=a,b`, курсором `?since=<ts>` и капом
// `?limit=N`. Trace докачивает инкремент на каждый `turn_end` и рисует строки
// без новых SSE-продюсеров: данные уже лежат в логе с `iteration`.
//
// Auth и same-origin — выше в `server.ts`.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionLogEntry } from "../../session/store";
import { redactContextSecrets } from "../../../core/api";
import { DIAGNOSTIC_EVENTS } from "../../../output";
import { stripAnsi } from "../../../ui/line-math";
import { sendJson } from "../util";
import type { SessionStore } from "../state";
import type { LlmRequestSnapshot } from "../../../llm/request-snapshot";

/** Диагностические типы по умолчанию (живой Trace докачивает именно их). */
export const TRACE_LOG_TYPES = [
  "assistant",
  "llm_usage",
  "compaction",
  "context_probe",
  "audit",
  "output",
  "critic_check",
  "critic_verdict",
  "critic_escalation",
  "gate_timing",
  "retract",
  "claim_retry",
  "llm_request",
  ...DIAGNOSTIC_EVENTS,
] as const;

/** Всё, что роут вообще готов отдать (закрытый список, не `*`). */
export const ALLOWED_TYPES = new Set<string>([
  ...TRACE_LOG_TYPES,
  "tool_call",
  "tool_result",
  "user",
  "error",
  "context",
  "service_task",
  "command",
  ...DIAGNOSTIC_EVENTS,
]);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function scrub(text: string | undefined): string | undefined {
  return text ? stripAnsi(redactContextSecrets(text)) : undefined;
}

/** Строковые поля с именами 1:1 в `SessionLogEntry` и `LogTailEntry`. */
type StrKey =
  | "status"
  | "kind"
  | "operation"
  | "errorKind"
  | "module"
  | "provider"
  | "model"
  | "tool"
  | "title"
  | "subtaskId"
  | "expertTag"
  | "tenantId"
  | "principalId"
  | "runId"
  | "jobId";
/** Числовые поля с именами 1:1. */
type NumKey =
  "iteration" | "promptTokens" | "completionTokens" | "totalTokens" | "duration" | "cycle";
const STR_FIELDS: readonly StrKey[] = [
  "status",
  "kind",
  "operation",
  "errorKind",
  "module",
  "provider",
  "model",
  "tool",
  "title",
  "subtaskId",
  "expertTag",
  "tenantId",
  "principalId",
  "runId",
  "jobId",
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
  operation?: string;
  errorKind?: string;
  module?: string;
  recoverable?: boolean;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  tool?: string;
  toolCallId?: string;
  success?: boolean;
  duration?: number;
  /** Разбивка простоя хода по гейтам (`gate_timing`, A15), мс. */
  gates?: { hallucination?: number; critic?: number; audit?: number };
  title?: string;
  subtaskId?: string;
  expertTag?: string;
  cycle?: number;
  tenantId?: string;
  principalId?: string;
  runId?: string;
  jobId?: string;
  /** Снимок исходящего запроса (`llm_request`, U20). */
  llmRequest?: LlmRequestSnapshot;
}

function copyStr(out: LogTailEntry, e: SessionLogEntry, f: StrKey): void {
  const v = e[f];
  if (typeof v === "string") out[f] = v;
}

function copyNum(out: LogTailEntry, e: SessionLogEntry, f: NumKey): void {
  const v = e[f];
  if (typeof v === "number") out[f] = v;
}

function copyGates(out: LogTailEntry, e: SessionLogEntry): void {
  const g = e.gates;
  if (!g || typeof g !== "object") return;
  const gates: NonNullable<LogTailEntry["gates"]> = {};
  for (const key of ["hallucination", "critic", "audit"] as const) {
    if (typeof g[key] === "number") gates[key] = g[key];
  }
  out.gates = gates;
}

function pick(e: SessionLogEntry): LogTailEntry {
  const out: LogTailEntry = { ts: e.ts, type: e.type };
  for (const f of STR_FIELDS) copyStr(out, e, f);
  for (const f of NUM_FIELDS) copyNum(out, e, f);
  copyGates(out, e);
  if (typeof e.success === "boolean") out.success = e.success;
  if (typeof e.recoverable === "boolean") out.recoverable = e.recoverable;
  // Единственное поле с разным именем: `tool_call_id` в логе → `toolCallId` на wire.
  if (typeof e.tool_call_id === "string") out.toolCallId = e.tool_call_id;
  const text = scrub(e.content ?? e.summary ?? e.message);
  if (text !== undefined) out.content = text;
  if (e.llmRequest && typeof e.llmRequest === "object") out.llmRequest = e.llmRequest;
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
  const types =
    opts.types && opts.types.length > 0 ? new Set(opts.types) : new Set(TRACE_LOG_TYPES);
  const since = opts.since ? Date.parse(opts.since) : NaN;
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
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
  s: SessionStore,
): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  const manager = s.sessionManager;
  if (!id) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const meta = manager.getWithStatus?.(id);
  if (meta?.status === "unreadable") {
    s.logger?.logSilent("warn", `session.log.read: meta unreadable for ${id} — ${meta.cause}`);
    sendJson(res, 500, { error: "read_failed", reason: "session meta unreadable" });
    return;
  }
  if (meta ? meta.status === "missing" : !manager.get(id)) {
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
  let truncated = false;
  try {
    // С курсором читаем только хвост лога (инкрементально, аудит §6.13).
    const since = q.get("since") ?? undefined;
    const read = manager.loadSessionLogWithStatus?.(id, since ? { since } : {});
    if (read?.status === "unreadable") {
      // INV-15: нечитаемый журнал — не пустой Trace. Иначе разбор полёта
      // показывает «записей нет» и прячет повреждение/мисматч шифрования.
      s.logger?.logSilent("warn", `session.log.read: ${id} unreadable — ${read.cause}`);
      sendJson(res, 500, { error: "read_failed", reason: "session log unreadable" });
      return;
    }
    if (read?.status === "ok") {
      log = read.value;
      truncated = read.truncated === true;
    } else if (read?.status !== "missing") {
      log = manager.loadSessionLog?.(id, since ? { since } : {}) ?? [];
    }
  } catch (err) {
    // Нечитаемая сессия: пустой хвост вместо провала всей страницы.
    s.logger?.logSilent(
      "warn",
      `session.log.read: ${id} threw — ${err instanceof Error ? err.message : String(err)}`,
    );
    sendJson(res, 500, { error: "read_failed", reason: "session log unreadable" });
    return;
  }
  sendJson(res, 200, {
    id,
    log: tailSessionLog(log, {
      types,
      since: q.get("since") ?? undefined,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    }),
    ...(truncated ? { truncated: true } : {}),
  });
}
