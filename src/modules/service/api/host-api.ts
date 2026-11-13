/**
 * Host-wire поверх job API (split W2): `/v1/host/*`.
 *
 * Это не второй путь исполнения хода: submit — тот же `dispatchInteractive`,
 * что `POST /v1/sessions/:id/tasks` с `mode: interactive`; поток событий —
 * тот же `openSessionStream`. Отличие только в форме запроса/ответа.
 *
 * `executeCommand` в W2 не реализован: хендлеры команд живут в CLI и требуют
 * `CommandServices` (перенос — W3). Роут не объявлен, клиент получает 404.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readMmaVersion } from "../../../core/version";
import { PROTOCOL_VERSION } from "../../daemon/protocol";
import { readJsonBodyOrProblem, sendJson, sendProblem } from "../http/respond";
import { resolveAnswer } from "../runtime/prompt-io";
import { problem } from "../runtime/problem";
import { hostStateOf } from "../runtime/host-state";
import type { AgentServiceState } from "../state";
import { openSessionStream } from "./events-api";
import { interruptSession } from "./tasks-control";
import { MAX_JSON_BYTES, tenantOf } from "./tasks-job";
import { dispatchInteractive } from "./tasks-submit";

/** Обработчик группы `/v1/host[...]`; `true` — запрос обработан. */
export async function handleHostApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
): Promise<boolean> {
  const parts = reqUrl.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "host") return false;

  if (parts.length === 3 && parts[2] === "state" && req.method === "GET") {
    return stateRoute(res, s, reqUrl);
  }
  if (parts.length !== 5 || parts[2] !== "sessions") return false;

  const sessionId = decodeURIComponent(parts[3]);
  const action = parts[4];
  if (!ensureSession(s, res, sessionId)) return true;

  if (action === "submit" && req.method === "POST") return submit(req, res, s, sessionId);
  if (action === "stream" && req.method === "GET") {
    openSessionStream(req, res, reqUrl, s, sessionId);
    return true;
  }
  if (action === "interrupt" && req.method === "POST") {
    sendJson(res, 202, { sessionId, interrupted: interruptSession(s, sessionId) });
    return true;
  }
  if ((action === "pause" || action === "resume") && req.method === "POST") {
    return setPaused(res, s, sessionId, action === "pause");
  }
  if (action === "answer" && req.method === "POST") return answer(req, res, s, sessionId);
  return false;
}

/** `GET /v1/host/state?session=` — снапшот + workspace/protocol. */
function stateRoute(res: ServerResponse, s: AgentServiceState, reqUrl: URL): boolean {
  const sessionId = reqUrl.searchParams.get("session") ?? undefined;
  sendJson(res, 200, {
    state: hostStateOf(s, sessionId),
    workspace: s.deps.baseDir ?? process.cwd(),
    version: readMmaVersion(),
    protocol: PROTOCOL_VERSION,
  });
  return true;
}

/** `POST /v1/host/sessions/:id/submit {text}` — интерактивный ход. */
async function submit(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    sendProblem(res, problem({ type: "validation", title: "text required", status: 400 }));
    return true;
  }
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > 0) {
    sendProblem(
      res,
      problem({
        type: "validation",
        title: "images are not supported over the host wire yet",
        status: 422,
      }),
    );
    return true;
  }
  const created = dispatchInteractive(s, sessionId, text, tenantOf(req, s));
  if (!created.ok) {
    sendProblem(
      res,
      problem({
        type: "queueFull",
        title: "session queue is full",
        status: 429,
        retriable: true,
        retryAfterMs: 1000,
      }),
    );
    return true;
  }
  res.setHeader("Location", `/v1/tasks/${created.task.jobId}`);
  sendJson(res, 202, {
    sessionId,
    turnId: created.task.jobId,
    jobId: created.task.jobId,
    status: created.task.status,
  });
  return true;
}

/** Пауза/резюме хода: durable-флаг на агенте уже поднятого раннера. */
function setPaused(
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
  paused: boolean,
): boolean {
  const agent = s.pool.getRunner(sessionId)?.agent as
    { pause?: () => void; resume?: () => void } | undefined;
  if (!agent || typeof agent.pause !== "function" || typeof agent.resume !== "function") {
    sendProblem(
      res,
      problem({
        type: "validation",
        title: "no active runner for session",
        status: 409,
        detail: sessionId,
      }),
    );
    return true;
  }
  if (paused) agent.pause();
  else agent.resume();
  sendJson(res, 202, { sessionId, paused });
  return true;
}

/** `POST /v1/host/sessions/:id/answer {id, answer}` — ответ на вопрос хода. */
async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    sendProblem(res, problem({ type: "validation", title: "question id required", status: 400 }));
    return true;
  }
  if (!resolveAnswer(s, id, body.answer, { sessionId })) {
    sendProblem(
      res,
      problem({ type: "validation", title: "unknown question id", status: 404, detail: id }),
    );
    return true;
  }
  sendJson(res, 202, { sessionId, status: "running" });
  return true;
}

/** Сессия обязана существовать; иначе 503/404 и `false`. */
function ensureSession(s: AgentServiceState, res: ServerResponse, sessionId: string): boolean {
  const manager = s.deps.sessionManager;
  if (!manager) {
    sendProblem(res, problem({ type: "internal", title: "sessions unavailable", status: 503 }));
    return false;
  }
  if (!manager.get(sessionId)) {
    sendProblem(
      res,
      problem({ type: "noSession", title: "session not found", status: 404, detail: sessionId }),
    );
    return false;
  }
  return true;
}
