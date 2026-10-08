/** `GET /v1/health` (liveness) и `GET /v1/ready` (readiness). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readMmaVersion } from "../../../core/version";
import { preflightFromConfig } from "../../providers/preflight";
import { errMsg } from "../../../utils/error";
import { sendJson, sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import type { AgentServiceState } from "../state";

/** Liveness: процесс жив (не проверяет провайдера). */
export function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { status: "ok", version: readMmaVersion() });
}

/** Readiness: конфиг загружен и активный провайдер отвечает на дешёвую пробу. */
export async function handleReady(
  _req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<void> {
  try {
    const r = await preflightFromConfig({ config: s.config });
    if (r.ok) {
      sendJson(res, 200, { status: "ready" });
      return;
    }
    sendProblem(
      res,
      problem({
        type: "providerUnavailable",
        title: "provider not ready",
        status: 503,
        detail: r.reason,
        retriable: true,
        retryAfterMs: 5000,
      }),
    );
  } catch (err) {
    sendProblem(
      res,
      problem({
        type: "providerUnavailable",
        title: "provider not ready",
        status: 503,
        detail: errMsg(err),
        retriable: true,
        retryAfterMs: 5000,
      }),
    );
  }
}
