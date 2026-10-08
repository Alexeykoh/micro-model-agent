/**
 * `/v1/sessions` CRUD (спека §6.1).
 *
 * Статус сессии выводится из `RunPool` (busy/очередь) и меты (rotated), а не
 * хранится отдельно. `externalRef` — опц. ключ интегратора; фильтр по нему —
 * в-process скан `list()` (авторитетный маппинг — control plane, Q5).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionMeta } from "../../session/types";
import { readJsonBody } from "../../webui/http/body";
import { sendJson, sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import type { SessionStatus, SessionSummary } from "../types";
import type { AgentServiceState } from "../state";

/** Кап тела JSON-запроса сервиса (тела маленькие, картинок тут нет). */
const MAX_JSON_BYTES = 1024 * 1024;

/** Статус сессии: busy → working, очередь → queued, rotated → archived. */
function statusOf(s: AgentServiceState, meta: SessionMeta): SessionStatus {
  if (s.pool.isBusy(meta.id)) return "working";
  if (s.pool.queueLen(meta.id) > 0) return "queued";
  if (meta.rotated) return "archived";
  return "idle";
}

/** Мету без утечки внутренних полей — в `SessionSummary`. */
function toSummary(s: AgentServiceState, meta: SessionMeta): SessionSummary {
  return {
    id: meta.id,
    ...(meta.externalRef ? { externalRef: meta.externalRef } : {}),
    name: meta.name,
    status: statusOf(s, meta),
    model: meta.model,
    contextWindow: meta.contextWindow,
    messageCount: meta.messageCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

/** Обработчик группы `/v1/sessions[...]`; `true` — запрос обработан. */
export async function handleSessionsApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
): Promise<boolean> {
  const parts = reqUrl.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "sessions") return false;
  // `/v1/sessions/:id/tasks` и глубже — другие группы.
  if (parts.length > 3) return false;

  const manager = s.deps.sessionManager;
  if (!manager) {
    sendProblem(res, problem({ type: "internal", title: "sessions unavailable", status: 503 }));
    return true;
  }

  if (parts.length === 2) {
    if (req.method === "POST") return createSession(req, res, s);
    if (req.method === "GET") return listSessions(res, reqUrl, s);
  }
  if (parts.length === 3) {
    const id = decodeURIComponent(parts[2]);
    if (req.method === "GET") return getSession(res, s, id);
    if (req.method === "DELETE") return deleteSession(res, s, id);
  }
  return false;
}

async function createSession(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<boolean> {
  const body = (await readJsonBody(req, MAX_JSON_BYTES)) ?? {};
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
  const externalRef =
    typeof body.externalRef === "string" && body.externalRef.trim()
      ? body.externalRef.trim()
      : undefined;
  const manager = s.deps.sessionManager!;
  const meta = manager.create(name, undefined, externalRef);
  s.deps.execModule?.switchSession?.(meta.id);
  sendJson(res, 201, toSummary(s, meta));
  return true;
}

function listSessions(res: ServerResponse, reqUrl: URL, s: AgentServiceState): boolean {
  const manager = s.deps.sessionManager!;
  const externalRef = reqUrl.searchParams.get("externalRef");
  const status = reqUrl.searchParams.get("status");
  let items = manager.list().map((m) => toSummary(s, m));
  if (externalRef !== null) items = items.filter((m) => m.externalRef === externalRef);
  if (status !== null) items = items.filter((m) => m.status === status);
  sendJson(res, 200, { sessions: items });
  return true;
}

function getSession(res: ServerResponse, s: AgentServiceState, id: string): boolean {
  const meta = s.deps.sessionManager!.get(id);
  if (!meta) {
    sendProblem(
      res,
      problem({ type: "noSession", title: "session not found", status: 404, detail: id }),
    );
    return true;
  }
  sendJson(res, 200, toSummary(s, meta));
  return true;
}

function deleteSession(res: ServerResponse, s: AgentServiceState, id: string): boolean {
  const manager = s.deps.sessionManager!;
  const meta = manager.get(id);
  if (!meta) {
    sendProblem(
      res,
      problem({ type: "noSession", title: "session not found", status: 404, detail: id }),
    );
    return true;
  }
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
