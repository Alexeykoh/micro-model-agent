/**
 * Host-wire: сессионная read-поверхность (split W3).
 *
 * Тонкий клиент не держит историю/сессии локально (INV-S4): список, создание,
 * удаление, история диалога и хвост `session.jsonl` читаются у демона.
 * Формат — те же `SessionMeta`/`SessionMessage`/`SessionLogEntry`, что у job API.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBodyOrProblem, sendJson, sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import type { AgentServiceState } from "../state";

/** Кап тела JSON-запроса (имена сессий маленькие). */
const MAX_JSON_BYTES = 1024 * 1024;
/** Дефолт и потолок хвоста лога. */
const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 2000;

/** `/v1/host/sessions[...]` — `true`/Promise, если запрос обработан. */
export function handleHostSessions(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
  parts: string[],
): boolean | Promise<boolean> {
  if (parts.length === 3) {
    if (req.method === "GET") {
      sendJson(res, 200, { sessions: s.deps.sessionManager?.list() ?? [] });
      return true;
    }
    if (req.method === "POST") return create(req, res, s);
    return false;
  }
  const id = parts.length >= 4 ? decodeURIComponent(parts[3]) : "";
  if (parts.length === 4 && req.method === "DELETE") return remove(res, s, id);
  if (parts.length === 5 && req.method === "GET") {
    if (parts[4] === "history") return history(res, s, id);
    if (parts[4] === "log") return log(res, s, id, reqUrl);
  }
  return false;
}

/** POST — создать сессию (`{name?}`). */
async function create(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<boolean> {
  const manager = s.deps.sessionManager;
  if (!manager) {
    sendProblem(res, problem({ type: "internal", title: "sessions unavailable", status: 503 }));
    return true;
  }
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
  const meta = manager.create(name);
  s.deps.execModule?.switchSession?.(meta.id);
  sendJson(res, 201, meta);
  return true;
}

/** DELETE — удалить простаивающую сессию; занятая → 409. */
function remove(res: ServerResponse, s: AgentServiceState, id: string): boolean {
  const manager = s.deps.sessionManager;
  if (!manager?.get(id)) return notFound(res, id);
  if (s.pool.isBusy(id) || s.pool.queueLen(id) > 0) {
    sendProblem(
      res,
      problem({ type: "validation", title: "session busy", status: 409, detail: id }),
    );
    return true;
  }
  s.pool.drop(id);
  s.envelopes.clear(id);
  s.deps.execModule?.forgetSession?.(id);
  manager.delete(id);
  res.writeHead(204);
  res.end();
  return true;
}

/** GET …/history — история диалога сессии. */
function history(res: ServerResponse, s: AgentServiceState, id: string): boolean {
  const manager = s.deps.sessionManager;
  if (!manager?.get(id)) return notFound(res, id);
  sendJson(res, 200, { messages: manager.getHistory(id) });
  return true;
}

/** GET …/log?since=&limit= — хвост `session.jsonl` (последние N записей). */
function log(res: ServerResponse, s: AgentServiceState, id: string, reqUrl: URL): boolean {
  const manager = s.deps.sessionManager;
  if (!manager?.get(id)) return notFound(res, id);
  const since = reqUrl.searchParams.get("since") ?? undefined;
  const limit = clampLimit(reqUrl.searchParams.get("limit"));
  const entries = manager.loadSessionLog(id, since ? { since } : {});
  sendJson(res, 200, { entries: entries.slice(-limit) });
  return true;
}

function clampLimit(raw: string | null): number {
  const n = raw ? Number(raw) : DEFAULT_LOG_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.floor(n), MAX_LOG_LIMIT);
}

function notFound(res: ServerResponse, id: string): boolean {
  sendProblem(
    res,
    problem({ type: "noSession", title: "session not found", status: 404, detail: id }),
  );
  return true;
}
