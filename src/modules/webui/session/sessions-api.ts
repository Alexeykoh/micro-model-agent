// REST-хендлеры поверхности `/api/sessions*` `mma web` (вынесены из config-api).
// Без менеджера/без `create` — пробел wiring: такие точки отвечают 503, не крашатся.
// Auth и same-origin — выше в `server.ts`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSessionHistory } from "./history-api";
import { handleSessionLog } from "./log-api";
import { readBody, readBodyError, sendJson } from "../util";
import { parseJsonBody, readJsonBody } from "../http/body";
import { isSessionBusy } from "./session-status";
import type { WebUiState } from "../state";

/** `GET /api/sessions` — список сессий (id/имя/обновление/модель/счёт). */
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
 * `POST /api/sessions {name?}` — новая сессия.
 *
 * Настоящий `SessionManager.create` заодно делает её активной, чтобы UI открыл
 * вкладку и SSE наполнил ленту. Менеджер без `create` (или без менеджера) —
 * пробел сервера: отвечаем 503.
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
        // План следует за сессией: новая — без плана, трекер сбрасывается.
        try {
          s.execModule?.switchSession(meta.id);
        } catch {
          // fail-open: сессия создана, план остался как был
        }
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

/** `POST /api/sessions/activate {id}` — переключить активную сессию. */
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
      // План следует за сессией: трекер переключается на план этой сессии
      // (или пустеет). Сайдбар следующего `/api/state` уже покажет его.
      try {
        s.execModule?.switchSession(id);
      } catch {
        // fail-open: сессия переключена, план остался как был
      }
      sendJson(res, 200, { ok: true });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/**
 * `DELETE /api/sessions/:id` — удалить сессию.
 *
 * Гард: АКТИВНУЮ удалять нельзя (409 `active_session`) — иначе агент останется
 * указывать на исчезнувший файл посреди хода; UI сначала переключается.
 * Чужие id — 404.
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
  // Per-session очередь: бегущую или стоящую в очереди сессию удалять нельзя —
  // иначе дренаж останется с владельцем-призраком. Клиент сначала переключается
  // / дожидается конца хода (тот же гард, что у активной).
  if (isSessionBusy(s, id)) {
    sendJson(res, 409, { error: "session_busy" });
    return;
  }
  try {
    s.sessionManager.delete(id);
  } catch {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  // Раннер простаивающей сессии больше не нужен: контекст/трекер выгружаются,
  // файлы слота остаются — следующий ход поднимет свежего из стора.
  // Сюда доходят только полностью idle сессии (бегущие/queued — 409 выше).
  s.pool.drop(id);
  delete s.sessionUsage[id];
  // План следует за сессией: слот удалённой сессии не оставляем мусором.
  try {
    s.execModule?.forgetSession(id);
  } catch {
    /* best-effort */
  }
  sendJson(res, 200, { ok: true });
}

/**
 * Диспатч роутов `/api/sessions*`. Возвращает, обработан ли запрос, чтобы
 * `server.ts` держал плоскую цепочку без дубля парсинга путей.
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
  if (p.startsWith("/api/sessions/") && p.endsWith("/log") && req.method === "GET") {
    const id = decodeURIComponent(p.slice("/api/sessions/".length, -"/log".length));
    handleSessionLog(req, res, id, s);
    return true;
  }
  if (p.startsWith("/api/sessions/") && req.method === "DELETE") {
    const id = decodeURIComponent(p.slice("/api/sessions/".length));
    handleSessionDelete(res, id, s);
    return true;
  }
  return false;
}
