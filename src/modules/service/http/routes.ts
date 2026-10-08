/**
 * Таблица маршрутов Agent Service API v1 (правило #17: карта, не цепочка `if`).
 *
 * Точные пути — `API_ROUTES`; параметрические (`/v1/sessions/:id/...`) —
 * `API_GROUPS` (префиксные хендлеры, каждый возвращает «обработано?»).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHealth, handleReady } from "../api/health";
import { handleEventsApi } from "../api/events-api";
import { handleSessionsApi } from "../api/sessions-api";
import { handleTasksApi } from "../api/tasks-api";
import { problem } from "../runtime/problem";
import { sendProblem } from "./respond";
import type { AgentServiceState } from "../state";

/** Хендлер маршрута: точный путь уже разрешён таблицей. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
) => void | Promise<void>;

/** Префиксный хендлер: `true` — запрос обработан. */
export type RouteGroup = (
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
) => boolean | Promise<boolean>;

const API_ROUTES: Record<string, RouteHandler> = {
  "GET /v1/health": (req, res) => handleHealth(req, res),
  "GET /v1/ready": (req, res, _reqUrl, s) => handleReady(req, res, s),
};

const API_GROUPS: RouteGroup[] = [handleSessionsApi, handleTasksApi, handleEventsApi];

/** Диспатч `/v1/*`: точное совпадение → группы → 404 problem. */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
): Promise<void> {
  const route = API_ROUTES[`${req.method} ${reqUrl.pathname}`];
  if (route) {
    await route(req, res, reqUrl, s);
    return;
  }
  for (const group of API_GROUPS) {
    if (await group(req, res, reqUrl, s)) return;
  }
  sendProblem(
    res,
    problem({ type: "validation", title: "not found", status: 404, detail: reqUrl.pathname }),
  );
}
