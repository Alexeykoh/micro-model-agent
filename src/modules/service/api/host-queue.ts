/**
 * Очередь сообщений через host wire (split W10): список, отмена, правка и
 * принудительный старт.
 *
 * Очередь — per-session FIFO в `RunPool`; действия адресуются стабильным `id`,
 * а не позицией (голова может стартовать между рендером и кликом).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBodyOrProblem, sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";
import { interruptSession } from "./tasks-control";

const MAX_JSON_BYTES = 1024 * 1024;

/** `/v1/host/sessions/:id/queue[...]` — `true`, если запрос обработан. */
export async function handleHostQueue(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
  sessionId: string,
): Promise<boolean> {
  const action = parts[5];
  if (req.method === "GET" && parts.length === 5) {
    sendJson(res, 200, {
      queued: s.pool.queueLen(sessionId),
      ids: s.pool.queuedIds(sessionId),
    });
    return true;
  }
  if (action !== "cancel" && action !== "edit" && action !== "start") return false;
  if (req.method !== "POST" || parts.length !== 6) return false;

  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    sendJson(res, 400, { error: "bad_request" });
    return true;
  }

  if (action === "cancel") {
    if (!s.pool.removeQueued(sessionId, id)) {
      sendJson(res, 404, { error: "not_queued" });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (action === "edit") {
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim() || !s.pool.editQueued(sessionId, id, text)) {
      sendJson(res, text.trim() ? 404 : 400, { error: text.trim() ? "not_queued" : "bad_request" });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }
  // start: в голову и аборт текущего хода — штатный drain поднимет её.
  if (!s.pool.promoteQueued(sessionId, id)) {
    sendJson(res, 404, { error: "not_queued" });
    return true;
  }
  const starting = s.pool.isBusy(sessionId);
  if (starting) interruptSession(s, sessionId);
  sendJson(res, starting ? 202 : 200, { ok: true, starting });
  return true;
}
