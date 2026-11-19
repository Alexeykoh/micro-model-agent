/**
 * `POST /v1/sessions/:id/tasks` — сабмит задачи: идемпотентность, очередь,
 * синхронное ожидание. Вынесено из `tasks-api.ts` (правило 6).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendProblem } from "../http/respond";
import { hashBody } from "../runtime/body-hash";
import { emitEvent } from "../runtime/emit";
import { problem } from "../runtime/problem";
import {
  isTerminal,
  type TaskCreateParams,
  type TaskRecord,
  type TenantContext,
} from "../runtime/task-registry";
import type { AgentServiceState } from "../state";
import { parseSubmitBody, type SubmitParams } from "./submit-body";
import { headerString, readJson, statusUrl, tenantOf, toJobObject } from "./tasks-job";
import { reserveAndStart, sendWebhook } from "./tasks-runner";

export async function submitTask(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
): Promise<boolean> {
  if (!ensureSession(s, res, sessionId)) return true;

  const body = await readJson(req, res);
  if (!body) return true;
  const parsed = parseSubmitBody(body, {
    networkConfig: s.config.security?.network,
    allowHttpCallback: s.config.service.webhookAllowHttp ?? false,
  });
  if (!parsed.ok) {
    sendProblem(res, parsed.problem);
    return true;
  }

  const tenant = tenantOf(req, s);
  const idemKey = headerString(req, "idempotency-key");
  const tenantKey = s.tenant.tenantId ?? "";

  const dedupe = resolveIdempotentSubmit(s, body, tenant.principalId ?? "anon", tenantKey, idemKey);
  if (dedupe.kind === "conflict") {
    sendProblem(res, problem({ type: "idempotencyConflict", title: "idempotency key reused with a different body or principal", status: 409 }));
    return true;
  }
  if (dedupe.kind === "hit") {
    return parsed.params.wait
      ? await respondSubmitWait(res, s, dedupe.task)
      : respondSubmit(res, s, dedupe.task);
  }

  const created = createAndDispatch(s, sessionId, parsed.params, tenant);
  if (!created.ok) {
    sendProblem(res, problem({ type: "queueFull", title: "session queue is full", status: 429, retriable: true, retryAfterMs: 1000 }));
    return true;
  }
  if (idemKey) {
    s.tasks.recordIdempotency(
      tenantKey,
      tenant.principalId ?? "anon",
      idemKey,
      hashBody(body),
      created.task.jobId,
    );
  }
  return parsed.params.wait
    ? await respondSubmitWait(res, s, created.task)
    : respondSubmit(res, s, created.task);
}

/**
 * Идемпотентность сабмита: тот же `Idempotency-Key` с тем же телом отдаёт
 * готовую задачу, с другим (или под другим principal) — `409`. Ответы — в
 * `submitTask`, чтобы `wait:true` одинаково работал для hit и miss.
 */
function resolveIdempotentSubmit(
  s: AgentServiceState,
  body: Record<string, unknown>,
  principal: string,
  tenantKey: string,
  idemKey: string | undefined,
): { kind: "none" } | { kind: "conflict" } | { kind: "hit"; task: TaskRecord } {
  if (!idemKey) return { kind: "none" };
  const bodyHash = hashBody(body);
  const lookup = s.tasks.checkIdempotency(tenantKey, principal, idemKey, bodyHash);
  if (lookup.kind === "conflict") return { kind: "conflict" };
  if (lookup.kind !== "hit") return { kind: "none" };
  const task = s.tasks.get(lookup.jobId);
  return task ? { kind: "hit", task } : { kind: "none" };
}

/** Проверяет наличие менеджера сессий и самой сессии; пишет Problem при провале. */
function ensureSession(s: AgentServiceState, res: ServerResponse, sessionId: string): boolean {
  const manager = s.deps.sessionManager;
  if (!manager) {
    sendProblem(res, problem({ type: "internal", title: "sessions unavailable", status: 503 }));
    return false;
  }
  if (!manager.get(sessionId)) {
    sendProblem(res, problem({ type: "noSession", title: "session not found", status: 404, detail: sessionId }));
    return false;
  }
  return true;
}

/** Создаёт задачу и ставит её в прогон/очередь; `false` — очередь сессии полна. */
function createAndDispatch(
  s: AgentServiceState,
  sessionId: string,
  params: SubmitParams,
  tenant: TenantContext,
  images: string[] = [],
): { ok: true; task: TaskRecord } | { ok: false } {
  if (queueFull(s, sessionId)) return { ok: false };
  const task = s.tasks.create(createParams(sessionId, params, tenant, images));
  if (s.pool.isBusy(sessionId)) {
    if (!enqueueTask(s, task)) return { ok: false };
  } else {
    reserveAndStart(s, task);
  }
  return { ok: true, task };
}

function createParams(
  sessionId: string,
  p: SubmitParams,
  tenant: TenantContext,
  images: string[] = [],
): TaskCreateParams {
  return {
    sessionId,
    mode: p.mode,
    input: p.input,
    ...(images.length ? { images } : {}),
    ...(p.output ? { output: p.output } : {}),
    ...(p.toolAllowlist.length ? { toolAllowlist: p.toolAllowlist } : {}),
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
    ...(p.callbackUrl ? { callbackUrl: p.callbackUrl } : {}),
    ...(p.externalRef ? { externalRef: p.externalRef } : {}),
    ...(Object.keys(tenant).length ? { tenant } : {}),
  };
}

/** Кладёт задачу в FIFO сессии; `false` — очередь полна. */
function enqueueTask(s: AgentServiceState, task: TaskRecord): boolean {
  const queued = s.pool.enqueue(task.sessionId, task.jobId, [], task.sessionId);
  if (queued === null) {
    s.tasks.finish(task.jobId, {
      status: "failed",
      error: problem({ type: "queueFull", title: "session queue is full", status: 429 }),
    });
    // Отказ enqueue — тоже терминальный исход: подписчик на webhook не должен ждать.
    sendWebhook(s, task);
    return false;
  }
  emitEvent(s, task, "task.accepted", {});
  return true;
}

function queueFull(s: AgentServiceState, sessionId: string): boolean {
  return s.pool.isBusy(sessionId) && s.pool.queueLen(sessionId) >= s.config.service.maxQueueLength;
}

/**
 * Интерактивный ход хоста (`POST /v1/host/sessions/:id/submit`): тот же
 * single-flight/FIFO путь, что у task API, без output-спеки и allowlist.
 */
export function dispatchInteractive(
  s: AgentServiceState,
  sessionId: string,
  text: string,
  tenant: TenantContext,
  images: string[] = [],
): { ok: true; task: TaskRecord } | { ok: false } {
  const params: SubmitParams = {
    input: text,
    mode: "interactive",
    toolAllowlist: [],
    wait: false,
  };
  return createAndDispatch(s, sessionId, params, tenant, images);
}

/** `wait:true` — ждём завершения до `syncWaitMs`, иначе 202 (таймер снимается). */
async function respondSubmitWait(
  res: ServerResponse,
  s: AgentServiceState,
  task: TaskRecord,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), s.config.service.syncWaitMs);
  try {
    const settled = await s.tasks.whenFinished(task.jobId, controller.signal);
    if (settled) {
      sendJson(res, 200, toJobObject(settled));
      return true;
    }
  } finally {
    clearTimeout(timer);
  }
  return respondSubmit(res, s, task);
}

/** Асинхронный ответ: терминальная задача → 200, иначе 202 + Location/Retry-After. */
function respondSubmit(res: ServerResponse, s: AgentServiceState, task: TaskRecord): boolean {
  const rec = s.tasks.get(task.jobId) ?? task;
  if (isTerminal(rec.status)) {
    sendJson(res, 200, toJobObject(rec));
    return true;
  }
  res.setHeader("Location", statusUrl(rec.jobId));
  res.setHeader("Retry-After", "5");
  sendJson(res, 202, { jobId: rec.jobId, status: rec.status, statusUrl: statusUrl(rec.jobId) });
  return true;
}
