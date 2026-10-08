/**
 * HTTP-транспорт Agent Service API v1 (`node:http`).
 *
 * `GET /v1/health` и `GET /v1/ready` — liveness/readiness без auth (их дёргает
 * оркестратор). Остальные `/v1/*` требуют bearer-токен, если он задан.
 * Non-loopback bind без токена отвергается на старте (спека §11).
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { t } from "../../i18n/index";
import { bearerOk, isLoopback, sendProblem } from "./http/respond";
import { handleApi } from "./http/routes";
import { problem } from "./runtime/problem";
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

/** Диспатч одного запроса: probes без auth → bearer-чек → `/v1/*` → 404. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<void> {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  res.setHeader("Cache-Control", "no-cache, no-transform");

  const isProbe = reqUrl.pathname === "/v1/health" || reqUrl.pathname === "/v1/ready";
  if (isProbe) {
    await handleApi(req, res, reqUrl, s);
    return;
  }
  if (!bearerOk(req, s.token)) {
    sendProblem(res, problem({ type: "validation", title: "unauthorized", status: 401 }));
    return;
  }
  if (reqUrl.pathname.startsWith("/v1/")) {
    await handleApi(req, res, reqUrl, s);
    return;
  }
  sendProblem(
    res,
    problem({ type: "validation", title: "not found", status: 404, detail: reqUrl.pathname }),
  );
}

/** Graceful stop: перестать принимать, разбудить ожидающих, сбросить пул/буферы. */
export function stopServiceServer(s: AgentServiceState): void {
  try {
    s.server?.close();
  } catch {
    /* сервер уже закрыт */
  }
  s.server = undefined;
  for (const pending of s.pendingQuestions.values()) pending.resolve(undefined);
  s.pendingQuestions.clear();
  s.clients.clear();
  s.pool.clear();
  s.envelopes.clear();
}
