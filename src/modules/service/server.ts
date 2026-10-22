/**
 * HTTP-транспорт Agent Service API v1 (`node:http`).
 *
 * `GET /v1/health` и `GET /v1/ready` — liveness/readiness без auth (их дёргает
 * оркестратор), плюс discovery (`/v1/openapi.json`, `/v1/docs`) — описание
 * публичного контракта, а не данные тенанта. Остальные `/v1/*` требуют
 * bearer-токен, если он задан. Non-loopback bind без токена отвергается на
 * старте (спека §11).
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { t } from "../../i18n/index";
import { defaultOutputBus } from "../../output";
import { errMsg } from "../../utils/error";
import { bearerOk, isLoopback, sendProblem } from "./http/respond";
import { handleApi } from "./http/routes";
import { problem } from "./runtime/problem";
import { apiGuard, filterResponse } from "../webui/egress";
import type { AgentServiceState } from "./state";

/** Поднимает сервер; резолвит базовый URL после успешного bind. */
export async function startServiceServer(s: AgentServiceState): Promise<string> {
  if (!isLoopback(s.host) && !s.token) {
    throw new Error(t("service.missing_token_nonloopback", { host: s.host }));
  }
  const server = createHttpServer((req, res) => {
    void handleRequest(req, res, s);
  });
  s.server = server;
  return await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(s.port, s.host, () => {
      const addr = server.address() as AddressInfo;
      s.port = addr.port;
      resolve(`http://${s.host}:${addr.port}`);
    });
  });
}

/** Пути без bearer-аутентификации: пробы оркестратора + discovery контракта. */
const OPEN_PATHS = new Set([
  "/v1/health",
  "/v1/ready",
  "/v1/openapi.json",
  "/v1/docs",
]);

/** Диспатч одного запроса: открытый путь → bearer-чек → `/v1/*` → 404. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<void> {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  res.setHeader("Cache-Control", "no-cache, no-transform");

  // E2: единая DLP-редакция REST и SSE (та же, что у web). Событие в логе
  // остаётся сырым (INV-D7) — фильтруется копия фрейма для клиента.
  const filtered = filterResponse(
    res,
    apiGuard({ config: s.config, workspace: s.deps.baseDir ?? process.cwd() }),
    reqUrl.pathname.endsWith("/events") ? "sse" : "json",
  );

  if (OPEN_PATHS.has(reqUrl.pathname)) {
    await dispatch(req, filtered, reqUrl, s);
    return;
  }
  if (!bearerOk(req, s.token)) {
    sendProblem(filtered, problem({ type: "validation", title: "unauthorized", status: 401 }));
    return;
  }
  if (!tenantOk(req, s)) {
    sendProblem(
      filtered,
      problem({ type: "tenantMismatch", title: "tenant does not match this process", status: 403 }),
    );
    return;
  }
  if (reqUrl.pathname.startsWith("/v1/")) {
    await dispatch(req, filtered, reqUrl, s);
    return;
  }
  sendProblem(
    filtered,
    problem({ type: "validation", title: "not found", status: 404, detail: reqUrl.pathname }),
  );
}

/**
 * Тенант запроса обязан совпадать с тенантом процесса (silo). Заголовок —
 * не источник правды: без него работаем под тенантом процесса, с чужим —
 * отказ, иначе один процесс обслуживал бы несколько тенантов (спека §10).
 *
 * DEBT(service-tier-scopes-control-plane): tier/scopes здесь не проверяются —
 * их выдаёт control plane, а не рантайм (silo: 1 процесс = 1 тенант).
 */
function tenantOk(req: IncomingMessage, s: AgentServiceState): boolean {
  const header = req.headers["x-mma-tenant"];
  const requested = typeof header === "string" ? header.trim() : "";
  if (!requested) return true;
  return requested === s.tenant.tenantId;
}

/**
 * Вызов маршрута под страховкой: любая непойманная ошибка становится
 * `500 internal` problem+json, а не обрывом сокета и не падением процесса
 * (сервис живёт неделями, и упасть от кривого запроса нельзя).
 */
async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
): Promise<void> {
  try {
    await handleApi(req, res, reqUrl, s);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const detail = errMsg(err);
    defaultOutputBus.log("warn", "module:service", `request failed: ${reqUrl.pathname}: ${detail}`);
    sendProblem(res, problem({ type: "internal", title: "internal error", status: 500, detail }));
  }
}

/** Graceful stop: перестать принимать, разбудить ожидающих, сбросить пул/буферы. */
export function stopServiceServer(s: AgentServiceState): void {
  try {
    s.server?.close();
  } catch {
    /* сервер уже закрыт */
  }
  s.server = undefined;
  if (s.pruneTimer) clearInterval(s.pruneTimer);
  s.pruneTimer = undefined;
  for (const pending of s.pendingQuestions.values()) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(undefined);
  }
  s.pendingQuestions.clear();
  s.clients.clear();
  s.pool.clear();
  s.envelopes.clear();
}
