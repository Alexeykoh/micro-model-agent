/**
 * Действия над сессией на host wire (split W10, правило ≤300): submit,
 * stream, interrupt, pause/resume, answer, command, картинки, очередь и
 * read-поверхность.
 *
 * Вынесено из `host-api.ts`, чтобы файл-маршрутизатор оставался картой путей.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseClientTz } from "../../../core/prompt-facts";
import { readJsonBodyOrProblem, sendJson, sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import { resolveAnswer } from "../runtime/prompt-io";
import { runHostCommand } from "../runtime/commands";
import type { AgentServiceState } from "../state";
import { MAX_JSON_BYTES, tenantOf } from "./tasks-job";
import { dispatchInteractive } from "./tasks-submit";
import { interruptSession } from "./tasks-control";
import { openSessionStream } from "./events-api";
import { serveSessionImage } from "./host-images";
import { handleHostQueue } from "./host-queue";
import { handleHostSessionView } from "./host-session-view";

/** Обрабатывает `/v1/host/sessions/:id/<action>`; `false` — путь не наш. */
export function handleHostSessionAction(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
  parts: string[],
): boolean | Promise<boolean> {
  const action = parts[4];
  if (
    parts.length !== 5 &&
    !(parts.length === 6 && (action === "images" || action === "queue")) &&
    !(parts.length === 7 && action === "subagents")
  ) {
    return false;
  }
  const sessionId = decodeURIComponent(parts[3]);
  if (!ensureSession(s, res, sessionId)) return true;

  if (action === "queue") return handleHostQueue(req, res, s, parts, sessionId);
  if (action === "system-prompt" || action === "security" || action === "subagents") {
    return handleHostSessionView(req, res, reqUrl, s, parts);
  }
  if (action === "images" && parts.length === 6 && req.method === "GET") {
    return serveSessionImage(res, s, sessionId, decodeURIComponent(parts[5]));
  }
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
  if (action === "command" && req.method === "POST") return command(req, res, s, sessionId);
  return false;
}

/** Максимум картинок и размер одного data-URL (как у web). */
const MAX_IMAGES = 10;
const MAX_IMAGE_DATA_URL_BYTES = 70 * 1024 * 1024;

/** Проверка `images`: только `data:image/...`, не больше 10 и 70 МБ каждая. */
function parseImages(
  raw: unknown,
): { ok: true; images: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "images must be an array" };
  if (raw.length > MAX_IMAGES) return { ok: false, error: "too many images" };
  const images: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.startsWith("data:image/")) {
      return { ok: false, error: "invalid image" };
    }
    if (Buffer.byteLength(item, "utf8") > MAX_IMAGE_DATA_URL_BYTES) {
      return { ok: false, error: "image too large" };
    }
    images.push(item);
  }
  return { ok: true, images };
}

/** `POST …/submit {text}` — интерактивный ход. */
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
  const parsed = parseImages(body.images);
  if (!parsed.ok) {
    sendProblem(res, problem({ type: "validation", title: parsed.error, status: 422 }));
    return true;
  }
  const clientTz = parseClientTz(body.clientTz);
  if (clientTz) s.pool.setClientTz(sessionId, clientTz);
  const created = dispatchInteractive(s, sessionId, text, tenantOf(req, s), parsed.images);
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

/** `POST …/answer {id, answer}` — ответ на вопрос хода. */
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

/** `POST …/command {line}` — серверное подмножество. */
async function command(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const line = typeof body.line === "string" ? body.line : "";
  if (!line.trim()) {
    sendProblem(res, problem({ type: "validation", title: "line required", status: 400 }));
    return true;
  }
  sendJson(res, 200, await runHostCommand(s, sessionId, line));
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
