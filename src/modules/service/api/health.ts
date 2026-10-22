/** `GET /v1/health` (liveness) и `GET /v1/ready` (readiness). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readMmaVersion } from "../../../core/version";
import { preflightFromConfig } from "../../providers/preflight";
import { errMsg } from "../../../utils/error";
import { sendJson, sendProblem } from "../http/respond";
import { problem } from "../runtime/problem";
import type { AgentServiceState } from "../state";

/** Кэш результата readiness: живой LLM-запрос не на каждый запрос оркестратора. */
const READY_CACHE_MS = 30_000;
/** `/v1/ready` — открытый путь: ограничиваем амфификацию по адресу клиента. */
const READY_RATE_LIMIT = 6;
const READY_RATE_WINDOW_MS = 60_000;

type ProbeResult = { ok: boolean; reason: string };

/** Liveness: процесс жив (не проверяет провайдера). */
export function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { status: "ok", version: readMmaVersion() });
}

/** Readiness: конфиг загружен и активный провайдер отвечает на дешёвую пробу. */
export async function handleReady(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<void> {
  const retryAfterMs = consumeReadyBudget(s, req.socket.remoteAddress ?? "unknown");
  if (retryAfterMs > 0) {
    sendProblem(
      res,
      problem({
        type: "rateLimited",
        title: "readiness probe rate limit exceeded",
        status: 429,
        retriable: true,
        retryAfterMs,
      }),
    );
    return;
  }
  try {
    const r = await probeProvider(s);
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

/** Провайдер-проба с кэшем на `READY_CACHE_MS` (успех и отказ кэшируются). */
async function probeProvider(s: AgentServiceState): Promise<ProbeResult> {
  const now = Date.now();
  if (s.readyCache && now - s.readyCache.at < READY_CACHE_MS) return s.readyCache.result;
  const result = s.deps.preflight ? await s.deps.preflight() : await preflightFromConfig({ config: s.config });
  s.readyCache = { at: now, result };
  return result;
}

/**
 * Списывает одну единицу бюджета `/v1/ready`; `>0` — лимит исчерпан
 * (значение — через сколько мс окно сбросится).
 */
function consumeReadyBudget(s: AgentServiceState, client: string): number {
  const now = Date.now();
  const entry = s.readyRate.get(client);
  if (!entry || entry.resetAt <= now) {
    s.readyRate.set(client, { count: 1, resetAt: now + READY_RATE_WINDOW_MS });
    return 0;
  }
  if (entry.count >= READY_RATE_LIMIT) return Math.max(1, entry.resetAt - now);
  entry.count += 1;
  return 0;
}
