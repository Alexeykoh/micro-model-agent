/**
 * `GET /v1/sessions/:id/events` — поток событий v1 (SSE).
 *
 * Envelope'ы монотонны по `seq`; `Last-Event-ID`/`?since=` дают resume из
 * in-memory буфера. Keep-alive `: ping` держит idle-соединение живым под
 * прокси; `X-Accel-Buffering: no` отключает буферизацию nginx. Закрытие
 * потока интерактивной задачи кооперативно её отменяет (спека §7.3), но только
 * если у сессии не осталось других подписчиков; `job`-ход продолжается.
 *
 * Потоки ограничены (`maxSseClients`), backpressure разрывает соединение, а
 * поток без событий дольше `sseIdleMs` закрывается сам.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { abortInteractiveTask } from "./tasks-api";
import { sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import { formatFrame } from "../runtime/emit";
import type { ServiceClient } from "../state";
import type { AgentServiceState } from "../state";

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
  if (s.clients.size >= s.maxSseClients) {
    sendProblem(
      res,
      problem({
        type: "rateLimited",
        title: "too many event streams",
        status: 503,
        retriable: true,
        retryAfterMs: 1000,
      }),
    );
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
    lastEventAt: Date.now(),
    send: (frame) => {
      client.lastEventAt = Date.now();
      safeWrite(res, frame);
    },
  };
  s.clients.add(client);

  const ping = setInterval(() => {
    if (Date.now() - client.lastEventAt > s.sseIdleMs) {
      res.end();
      return;
    }
    safeWrite(res, ": ping\n\n");
  }, s.keepaliveMs);
  (ping as { unref?: () => void }).unref?.();

  req.on("close", () => {
    clearInterval(ping);
    s.clients.delete(client);
    // Чужой подписчик не должен терять задачу из-за закрытия этой вкладки.
    if (!hasSubscribers(s, sessionId)) abortInteractiveTask(s, sessionId);
  });
  return true;
}

/** Есть ли у сессии хотя бы один живой SSE-подписчик. */
function hasSubscribers(s: AgentServiceState, sessionId: string): boolean {
  for (const client of s.clients) if (client.sessionId === sessionId) return true;
  return false;
}

/** `Last-Event-ID` (заголовок) важнее `?since=`; нечисловое → 0. */
function parseSince(req: IncomingMessage, reqUrl: URL): number {
  const header = req.headers["last-event-id"];
  const raw = typeof header === "string" && header.trim() ? header : reqUrl.searchParams.get("since");
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Пишет фрейм; `false` (буфер переполнен) — рвём соединение: медленный клиент
 * не должен копить память процесса. Закрытие придёт событием `close`.
 */
function safeWrite(res: ServerResponse, frame: string): boolean {
  try {
    if (!res.write(frame)) {
      res.destroy();
      return false;
    }
    return true;
  } catch {
    res.destroy();
    return false;
  }
}
