/**
 * `/v1/sessions/:id/tasks` и `/v1/tasks/:jobId[...]` (спека §6.2, §9).
 *
 * Задача = ход над сессией. Сабмит — single-flight через `RunPool`: занятая
 * сессия кладёт задачу в FIFO, свободная стартует сразу. `Idempotency-Key`
 * дедуплицирует повтор; `wait:true` синхронно ждёт до `service.syncWaitMs`.
 * Статус/результат читаются pull'ом; webhook — оптимизация (Фаза 7).
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRunner } from "../../../core/bootstrap/session-runner";
import { readJsonBody } from "../../webui/http/body";
import { errMsg } from "../../../utils/error";
import { sendJson, sendProblem } from "../http/respond";
import { problem, type ProblemDetails } from "../runtime/problem";
import { emitEvent } from "../runtime/emit";
import { makeServiceForwarder } from "../runtime/event-bridge";
import { installServicePromptIO, resolveAnswer } from "../runtime/prompt-io";
import { runTask, type RunTaskResult } from "../runtime/run-task";
import { deliverWebhook } from "../runtime/webhook";
import { newEventId } from "../runtime/ids";
import {
  isTerminal,
  type TaskCreateParams,
  type TaskMode,
  type TaskOutputSpec,
  type TaskRecord,
} from "../runtime/task-registry";
import type { JobObject } from "../types";
import type { AgentServiceState } from "../state";

/** Кап тела JSON-запроса сервиса (задачи текстовые, картинок тут нет). */
const MAX_JSON_BYTES = 1024 * 1024;

/** Строит Job-объект из внутренней записи (единый контракт pull/push). */
export function toJobObject(rec: TaskRecord): JobObject {
  return {
    jobId: rec.jobId,
    sessionId: rec.sessionId,
    status: rec.status,
    mode: rec.mode,
    ...(rec.progress ? { progress: rec.progress } : {}),
    ...(rec.result ? { result: rec.result } : {}),
    ...(rec.usage ? { usage: rec.usage } : {}),
    ...(rec.error ? { error: rec.error } : {}),
    createdAt: rec.createdAt,
    ...(rec.startedAt ? { startedAt: rec.startedAt } : {}),
    ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
  };
}

/** Обработчик группы задач; `true` — запрос обработан. */
export async function handleTasksApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: AgentServiceState,
): Promise<boolean> {
  const parts = reqUrl.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1") return false;

  if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "tasks") {
    if (req.method !== "POST") return false;
    return submit(req, res, s, decodeURIComponent(parts[2]));
  }
  if (parts[1] === "tasks" && parts.length === 3 && req.method === "GET") {
    return status(res, s, decodeURIComponent(parts[2]));
  }
  if (parts[1] === "tasks" && parts.length === 4 && req.method === "POST") {
    const jobId = decodeURIComponent(parts[2]);
    if (parts[3] === "cancel") return cancel(res, s, jobId);
    if (parts[3] === "answer") return answer(req, res, s, jobId);
  }
  return false;
}

// ── Submit ────────────────────────────────────────────────────────────────

/** Разобранный сабмит: валидированные параметры задачи. */
interface SubmitParams {
  input: string;
  mode: TaskMode;
  output?: TaskOutputSpec;
  toolAllowlist: string[];
  timeoutMs?: number;
  callbackUrl?: string;
  externalRef?: string;
  wait: boolean;
}

type SubmitParse = { ok: true; params: SubmitParams } | { ok: false; problem: ProblemDetails };

async function submit(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
): Promise<boolean> {
  const manager = s.deps.sessionManager;
  if (!manager) {
    sendProblem(res, problem({ type: "internal", title: "sessions unavailable", status: 503 }));
    return true;
  }
  if (!manager.get(sessionId)) {
    sendProblem(res, problem({ type: "noSession", title: "session not found", status: 404, detail: sessionId }));
    return true;
  }

  const body = await readJson(req);
  const parsed = parseSubmitBody(body);
  if (!parsed.ok) {
    sendProblem(res, parsed.problem);
    return true;
  }

  const principal = principalOf(req);
  const idemKey = headerString(req, "idempotency-key");
  const bodyHash = hashBody(body);

  const early = checkIdempotency(s, principal, idemKey, bodyHash);
  if (early.kind === "conflict") {
    sendProblem(res, problem({ type: "idempotencyConflict", title: "idempotency key reused with a different body", status: 409 }));
    return true;
  }
  if (early.kind === "hit") return respondSubmit(res, s, early.task);

  const created = createAndDispatch(s, sessionId, parsed.params);
  if (!created.ok) {
    sendProblem(res, problem({ type: "queueFull", title: "session queue is full", status: 429, retriable: true, retryAfterMs: 1000 }));
    return true;
  }
  if (idemKey) s.tasks.recordIdempotency(principal, idemKey, bodyHash, created.task.jobId);
  return parsed.params.wait
    ? await respondSubmitWait(res, s, created.task)
    : respondSubmit(res, s, created.task);
}

/** Итог проверки Idempotency-Key: нет ключа / hit (готовая задача) / конфликт тела. */
type IdemCheck = { kind: "none" } | { kind: "conflict" } | { kind: "hit"; task: TaskRecord };

function checkIdempotency(
  s: AgentServiceState,
  principal: string,
  key: string | undefined,
  bodyHash: string,
): IdemCheck {
  if (!key) return { kind: "none" };
  const lookup = s.tasks.checkIdempotency(principal, key, bodyHash);
  if (lookup.kind === "conflict") return { kind: "conflict" };
  if (lookup.kind === "hit") {
    const task = s.tasks.get(lookup.jobId);
    if (task) return { kind: "hit", task };
  }
  return { kind: "none" };
}

/** Создаёт задачу и ставит её в прогон/очередь; `false` — очередь сессии полна. */
function createAndDispatch(
  s: AgentServiceState,
  sessionId: string,
  params: SubmitParams,
): { ok: true; task: TaskRecord } | { ok: false } {
  if (queueFull(s, sessionId)) return { ok: false };
  const task = s.tasks.create(createParams(sessionId, params));
  if (s.pool.isBusy(sessionId)) {
    if (!enqueueTask(s, task)) return { ok: false };
  } else {
    reserveAndStart(s, task);
  }
  return { ok: true, task };
}

/** Валидирует тело сабмита; ошибка → готовый Problem Details. */
function parseSubmitBody(body: Record<string, unknown>): SubmitParse {
  const input = typeof body.input === "string" ? body.input : "";
  if (!input.trim()) return submitError("input required", 400);
  const output = parseOutput(body.output);
  if (!output.ok) return submitError("invalid output spec", 422, output.detail);
  const toolAllowlist = parseStringArray(body.toolAllowlist);
  if (toolAllowlist === null) return submitError("invalid toolAllowlist", 400);
  const timeout = parseTimeout(body.timeoutMs);
  if (!timeout.ok) return submitError("invalid timeoutMs", 400);
  return { ok: true, params: buildSubmitParams(body, input, output.output, toolAllowlist, timeout.value) };
}

function submitError(title: string, status: number, detail?: string): SubmitParse {
  return { ok: false, problem: validation(title, status, detail) };
}

function buildSubmitParams(
  body: Record<string, unknown>,
  input: string,
  output: TaskOutputSpec | undefined,
  toolAllowlist: string[],
  timeoutMs: number | undefined,
): SubmitParams {
  return {
    input,
    mode: body.mode === "interactive" ? "interactive" : "job",
    ...(output ? { output } : {}),
    toolAllowlist,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...stringParam(body, "callbackUrl"),
    ...stringParam(body, "externalRef"),
    wait: body.wait === true,
  };
}

/** Струнная опция тела как `{[key]: value}` или пустой объект. */
function stringParam(body: Record<string, unknown>, key: string): Record<string, string> {
  const value = body[key];
  return typeof value === "string" ? { [key]: value } : {};
}

/** Проверяет необязательный числовой таймаут: absent → ok, битый → не ok. */
function parseTimeout(raw: unknown): { ok: true; value?: number } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const value = parseOptionalInt(raw);
  return value === undefined ? { ok: false } : { ok: true, value };
}

function createParams(sessionId: string, p: SubmitParams): TaskCreateParams {
  return {
    sessionId,
    mode: p.mode,
    input: p.input,
    ...(p.output ? { output: p.output } : {}),
    ...(p.toolAllowlist.length ? { toolAllowlist: p.toolAllowlist } : {}),
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
    ...(p.callbackUrl ? { callbackUrl: p.callbackUrl } : {}),
    ...(p.externalRef ? { externalRef: p.externalRef } : {}),
  };
}

/** Кладёт задачу в FIFO сессии; `false` — очередь полна. */
function enqueueTask(s: AgentServiceState, task: TaskRecord): boolean {
  const pos = s.pool.enqueue(task.sessionId, task.jobId, [], task.sessionId);
  if (pos === null) {
    s.tasks.finish(task.jobId, {
      status: "failed",
      error: problem({ type: "queueFull", title: "session queue is full", status: 429 }),
    });
    return false;
  }
  emitEvent(s, task, "task.accepted", {});
  return true;
}

function queueFull(s: AgentServiceState, sessionId: string): boolean {
  return s.pool.isBusy(sessionId) && s.pool.queueLen(sessionId) >= s.config.service.maxQueueLength;
}

/** `wait:true` — ждём завершения до `syncWaitMs`, иначе 202. */
async function respondSubmitWait(
  res: ServerResponse,
  s: AgentServiceState,
  task: TaskRecord,
): Promise<boolean> {
  const settled = await Promise.race([
    s.tasks.whenFinished(task.jobId),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), s.config.service.syncWaitMs)),
  ]);
  if (settled) {
    sendJson(res, 200, toJobObject(settled));
    return true;
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

// ── Runner lifecycle ──────────────────────────────────────────────────────

/** Резервирует слот сессии и стартует задачу (fire-and-forget, отказ — в статус). */
function reserveAndStart(s: AgentServiceState, task: TaskRecord): void {
  s.pool.reserve(task.sessionId);
  void startTask(s, task);
}

async function startTask(s: AgentServiceState, task: TaskRecord): Promise<void> {
  s.tasks.update(task.jobId, { status: "running", startedAt: new Date().toISOString() });
  emitEvent(s, task, "task.started", {});

  let runner: SessionRunner;
  try {
    runner = s.pool.getOrCreateRunner(task.sessionId);
  } catch (err) {
    finishFailure(s, task, problem({ type: "internal", title: "runner unavailable", status: 500, detail: errMsg(err) }));
    return;
  }

  if (task.mode === "interactive") installServicePromptIO(s, task, runner);

  const forwarder = makeServiceForwarder({
    emit: (type, data) => emitEvent(s, task, type, data),
  });
  const disarmTimeout = armTimeout(task, runner);

  try {
    const result = await runTask({
      runner,
      task,
      forwarder,
      onPlan: (plan) => emitEvent(s, task, "plan", { steps: plan.steps, currentIndex: plan.currentIndex }),
    });
    if (isCancelled(s, task)) return;
    if (disarmTimeout()) {
      finishFailure(s, task, problem({ type: "timeout", title: "task timed out", status: 408, detail: `timeoutMs=${task.timeoutMs ?? 0}` }));
      return;
    }
    settleTask(s, task, result);
  } catch (err) {
    if (!isCancelled(s, task)) {
      finishFailure(s, task, problem({ type: "internal", title: "task failed", status: 500, detail: errMsg(err) }));
    }
  } finally {
    disarmTimeout();
    // Слот свободен: терминальный ход завершён; дренируем очередь сессии.
    s.pool.forceRelease(task.sessionId);
    drain(s, task.sessionId);
  }
}

/** Взводит таймаут задачи; возвращает функцию «снять таймер → сработал ли». */
function armTimeout(task: TaskRecord, runner: SessionRunner): () => boolean {
  if (!task.timeoutMs || task.timeoutMs <= 0) return () => false;
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    try {
      runner.agent.shutdown(task.sessionId);
    } catch {
      /* graceful shutdown best-effort */
    }
  }, task.timeoutMs);
  return () => {
    clearTimeout(timer);
    return fired;
  };
}

/** Терминальная запись задачи по результату хода (успех/структурный провал/сбой). */
function settleTask(s: AgentServiceState, task: TaskRecord, result: RunTaskResult): void {
  if (result.success) {
    const resultObj = { text: result.text, ...(result.data !== undefined ? { data: result.data } : {}) };
    s.tasks.finish(task.jobId, { status: "succeeded", result: resultObj, usage: result.usage });
    emitEvent(s, task, "task.finished", { result: resultObj, usage: result.usage });
    sendWebhook(s, task);
    return;
  }
  if (result.outputInvalid) {
    finishFailure(
      s,
      task,
      problem({ type: "outputInvalid", title: "structured output validation failed", status: 422, detail: result.error }),
    );
    return;
  }
  finishFailure(s, task, problem({ type: "internal", title: "task failed", status: 500, detail: result.error }));
}

/** Дренирует FIFO сессии: следующий queued-таск (отменённые пропускаются). */
function drain(s: AgentServiceState, sessionId: string): void {
  const next = s.pool.shift(sessionId);
  if (!next) return;
  const rec = s.tasks.get(next.text);
  if (rec?.status !== "queued") {
    drain(s, sessionId);
    return;
  }
  reserveAndStart(s, rec);
}

function isCancelled(s: AgentServiceState, task: TaskRecord): boolean {
  return s.tasks.get(task.jobId)?.status === "cancelled";
}

function finishFailure(s: AgentServiceState, task: TaskRecord, pd: ProblemDetails): void {
  const status = pd.type.endsWith("/timeout") ? "timeout" : "failed";
  s.tasks.finish(task.jobId, { status, error: pd });
  emitEvent(s, task, "task.failed", { error: pd });
  sendWebhook(s, task);
}

/** Фаер-и-форгет push терминального Job-объекта (pull остаётся источником правды). */
function sendWebhook(s: AgentServiceState, task: TaskRecord): void {
  const rec = s.tasks.get(task.jobId);
  if (!rec?.callbackUrl || !isTerminal(rec.status)) return;
  void deliverWebhook({
    url: rec.callbackUrl,
    secret: s.config.service.webhookSecret,
    eventId: newEventId(),
    body: JSON.stringify(toJobObject(rec)),
    timeoutMs: s.config.service.callbackTimeoutMs,
  }).catch(() => {
    /* pull доступен и при недоставке push */
  });
}

// ── Status / Cancel / Answer ──────────────────────────────────────────────

function status(res: ServerResponse, s: AgentServiceState, jobId: string): boolean {
  const rec = s.tasks.get(jobId);
  if (!rec) {
    sendProblem(res, problem({ type: "noTask", title: "task not found", status: 404, detail: jobId }));
    return true;
  }
  sendJson(res, 200, toJobObject(rec));
  return true;
}

function cancel(res: ServerResponse, s: AgentServiceState, jobId: string): boolean {
  const rec = s.tasks.get(jobId);
  if (!rec) {
    sendProblem(res, problem({ type: "noTask", title: "task not found", status: 404, detail: jobId }));
    return true;
  }
  if (isTerminal(rec.status)) {
    sendJson(res, 200, { jobId, status: rec.status });
    return true;
  }
  const wasRunning = rec.status === "running";
  s.tasks.finish(jobId, { status: "cancelled" });
  emitEvent(s, rec, "task.cancelled", {});
  sendWebhook(s, rec);
  if (wasRunning) {
    try {
      s.pool.getRunner(rec.sessionId)?.agent.shutdown(rec.sessionId);
    } catch {
      /* cooperative cancel best-effort */
    }
  }
  sendJson(res, 202, { jobId, status: "cancelled" });
  return true;
}

/** `POST /v1/tasks/:jobId/answer` — ответ на `question` интерактивной задачи. */
async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  jobId: string,
): Promise<boolean> {
  const rec = s.tasks.get(jobId);
  if (!rec) {
    sendProblem(res, problem({ type: "noTask", title: "task not found", status: 404, detail: jobId }));
    return true;
  }
  if (rec.status !== "waiting_input") {
    sendProblem(res, problem({ type: "validation", title: "task is not waiting for input", status: 409, detail: rec.status }));
    return true;
  }
  const body = (await readJsonBody(req, MAX_JSON_BYTES)) ?? {};
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    sendProblem(res, problem({ type: "validation", title: "question id required", status: 400 }));
    return true;
  }
  if (!resolveAnswer(s, id, body.answer)) {
    sendProblem(res, problem({ type: "validation", title: "unknown question id", status: 404, detail: id }));
    return true;
  }
  sendJson(res, 202, { jobId, status: "running" });
  return true;
}

// ── Parsing helpers ───────────────────────────────────────────────────────

function statusUrl(jobId: string): string {
  return `/v1/tasks/${jobId}`;
}

/** Тело JSON-запроса как объект (пусто/бито → `{}`). */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return (await readJsonBody(req, MAX_JSON_BYTES)) ?? {};
}

/** Principal из auth-заголовка control plane (иначе `anon`). */
function principalOf(req: IncomingMessage): string {
  return headerString(req, "x-mma-principal") ?? "anon";
}

/** Хеш тела для сравнения Idempotency-Key. */
function hashBody(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function validation(title: string, status: number, detail?: string): ProblemDetails {
  return problem({ type: "validation", title, status, ...(detail ? { detail } : {}) });
}

function headerString(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** True для обычного JSON-объекта (не массив/null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFormat(value: unknown): value is "text" | "json" {
  return value === "text" || value === "json";
}

function failOutput(detail: string): { ok: false; detail: string } {
  return { ok: false, detail };
}

function parseOutput(
  raw: unknown,
): { ok: true; output?: TaskOutputSpec } | { ok: false; detail: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!isRecord(raw)) return failOutput("output must be an object");
  const { format, schema } = raw;
  if (!isFormat(format)) return failOutput("output.format must be 'text' or 'json'");
  if (format === "json" && schema !== undefined && !isRecord(schema)) {
    return failOutput("output.schema must be an object");
  }
  return { ok: true, output: { format, ...(schema !== undefined ? { schema } : {}) } };
}

function parseStringArray(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) return null;
  return raw as string[];
}

function parseOptionalInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  return undefined;
}
