/**
 * REST handlers for the `/api/sessions*` surface of `mma web`.
 *
 * Split out of `config-api.ts` (rule #1: ≤300 lines/file) once session
 * creation landed. Handlers read the optional `sessionManager` collaborator
 * wired from bootstrap; a missing one (or one without `create`) is a
 * server-side wiring gap, so those endpoints answer 503 instead of crashing.
 *
 * Auth + same-origin are enforced upstream in `server.ts`; these functions
 * assume the request already passed both checks.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSessionHistory } from "./history-api";
import { readBody, readBodyError, sendJson } from "./util";
import { parseJsonBody, readJsonBody } from "./body";
import type { WebUiState } from "./state";

/** `GET /api/sessions` — list sessions (id/name/updatedAt/model/messageCount). */
export function handleSessionsGet(res: ServerResponse, s: WebUiState): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  const sessions = s.sessionManager.list().map((meta) => ({
    id: meta.id,
    name: meta.name,
    updatedAt: meta.updatedAt,
    model: meta.model,
    messageCount: meta.messageCount,
  }));
  sendJson(res, 200, { sessions });
}

/**
 * `POST /api/sessions {name?}` — create a new session.
 *
 * The real `SessionManager.create` also makes the new session active, so the UI
 * can open it as a tab and let SSE populate the feed. A manager wired without
 * `create` (or no manager at all) is a server-side gap: answer 503.
 */
export function handleSessionCreate(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
): void {
  const manager = s.sessionManager;
  if (!manager || typeof manager.create !== "function") {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  const create = manager.create.bind(manager);
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      let name: string | undefined;
      if (raw.trim()) {
        const rec = parseJsonBody(raw);
        if (!rec) {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (typeof rec.name === "string" && rec.name.trim()) name = rec.name.trim();
      }
      try {
        const meta = create(name);
        sendJson(res, 201, {
          ok: true,
          session: {
            id: meta.id,
            name: meta.name,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            messageCount: meta.messageCount,
            model: meta.model,
          },
        });
      } catch {
        sendJson(res, 500, { error: "create_failed" });
      }
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** `POST /api/sessions/activate {id}` — switch the active session. */
export function handleSessionActivate(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  const manager = s.sessionManager;
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec) {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const id = typeof rec.id === "string" ? rec.id : "";
      if (!id) {
        sendJson(res, 400, { error: "missing id" });
        return;
      }
      try {
        manager.setActive(id);
      } catch {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      sendJson(res, 200, { ok: true });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/**
 * `DELETE /api/sessions/:id` — remove a session.
 *
 * Guard: the ACTIVE session cannot be deleted (409 `active_session`). Deleting
 * it would leave the agent pointing at a vanished session file mid-turn; the UI
 * must switch away first. Unknown ids answer 404.
 */
export function handleSessionDelete(res: ServerResponse, id: string, s: WebUiState): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  if (!id || !s.sessionManager.get(id)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (s.sessionManager.getActive() === id) {
    sendJson(res, 409, { error: "active_session" });
    return;
  }
  try {
    s.sessionManager.delete(id);
  } catch {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * Dispatch `/api/sessions*` routes. Returns whether the request was handled so
 * `server.ts` keeps a flat chain without duplicating path parsing here.
 */
export function handleSessionsApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
): boolean {
  const p = reqUrl.pathname;
  if (p === "/api/sessions" && req.method === "GET") {
    handleSessionsGet(res, s);
    return true;
  }
  if (p === "/api/sessions" && req.method === "POST") {
    handleSessionCreate(req, res, s);
    return true;
  }
  if (p === "/api/sessions/activate" && req.method === "POST") {
    handleSessionActivate(req, res, s);
    return true;
  }
  if (p.startsWith("/api/sessions/") && p.endsWith("/history") && req.method === "GET") {
    const id = decodeURIComponent(p.slice("/api/sessions/".length, -"/history".length));
    handleSessionHistory(res, id, s);
    return true;
  }
  if (p.startsWith("/api/sessions/") && req.method === "DELETE") {
    const id = decodeURIComponent(p.slice("/api/sessions/".length));
    handleSessionDelete(res, id, s);
    return true;
  }
  return false;
}
