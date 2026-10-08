/**
 * `GET /v1/sessions/:id/events` — поток событий v1 (SSE).
 *
 * Envelope'ы монотонны по `seq`; `Last-Event-ID`/`?since=` дают resume из
 * in-memory буфера. Keep-alive `: ping` держит idle-соединение живым под
 * прокси; `X-Accel-Buffering: no` отключает буферизацию nginx. Закрытие
 * потока интерактивной задачи кооперативно её отменяет (спека §7.3); `job`-ход
 * продолжается (pull — источник правды).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { abortInteractiveTask } from "./tasks-api";
import { sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import { formatFrame } from "../runtime/emit";
import type { ServiceClient } from "../state";
import type { AgentServiceState } from "../state";

const KEEPALIVE_MS = 20_000;

/** Обработчик группы `/v1/sessions/:id/events`; `true` — запрос обработан. */
export function handleEventsApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
): boolean {
  const parts = reqUrl.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "sessions" || parts.length !== 4 || parts[3] !== "events") {
    return false;
  }
  if (req.method !== "GET") return false;

  const sessionId = decodeURIComponent(parts[2]);
  if (!s.deps.sessionManager?.get(sessionId)) {
    sendProblem(res, problem({ type: "noSession", title: "session not found", status: 404, detail: sessionId }));
    return true;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "identity",
  });
  res.flushHeaders?.();

  for (const env of s.envelopes.since(sessionId, parseSince(req, reqUrl))) {
    safeWrite(res, formatFrame(env));
  }

  const client: ServiceClient = {
    sessionId,
    lastEventId: 0,
    send: (frame) => safeWrite(res, frame),
  };
  s.clients.add(client);

  const ping = setInterval(() => safeWrite(res, ": ping\n\n"), KEEPALIVE_MS);
  (ping as { unref?: () => void }).unref?.();

  req.on("close", () => {
    clearInterval(ping);
    s.clients.delete(client);
    abortInteractiveTask(s, sessionId);
  });
  return true;
}

/** `Last-Event-ID` (заголовок) важнее `?since=`; нечисловое → 0. */
function parseSince(req: IncomingMessage, reqUrl: URL): number {
  const header = req.headers["last-event-id"];
  const raw = typeof header === "string" && header.trim() ? header : reqUrl.searchParams.get("since");
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function safeWrite(res: ServerResponse, frame: string): void {
  try {
    res.write(frame);
  } catch {
    /* клиент отвалился — поток закроется событием close */
  }
}
