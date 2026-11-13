/**
 * `GET /v1/tasks/:jobId`, `POST …/cancel`, `POST …/answer` и кооперативная
 * отмена интерактивной задачи. Вынесено из `tasks-api.ts` (правило 6).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBodyOrProblem, sendJson, sendProblem } from "../http/respond";
import { emitEvent } from "../runtime/emit";
import { problem } from "../runtime/problem";
import { cancelTaskQuestions, resolveAnswer } from "../runtime/prompt-io";
import { isTerminal, type TaskRecord } from "../runtime/task-registry";
import type { AgentServiceState } from "../state";
import { MAX_JSON_BYTES, toJobObject } from "./tasks-job";
import { sendWebhook } from "./tasks-runner";

/**
 * Задача, принадлежащая тенанту процесса. Чужая/неизвестная → `undefined`
 * (404: не подтверждаем существование чужой задачи).
 */
function ownedTask(s: AgentServiceState, jobId: string): TaskRecord | undefined {
  const rec = s.tasks.get(jobId);
  if (!rec) return undefined;
  return (rec.tenant?.tenantId ?? undefined) === (s.tenant.tenantId ?? undefined) ? rec : undefined;
}

export function taskStatus(res: ServerResponse, s: AgentServiceState, jobId: string): boolean {
  const rec = ownedTask(s, jobId);
  if (!rec) {
    sendProblem(res, problem({ type: "noTask", title: "task not found", status: 404, detail: jobId }));
    return true;
  }
  sendJson(res, 200, toJobObject(rec));
  return true;
}

export function cancelTaskRoute(res: ServerResponse, s: AgentServiceState, jobId: string): boolean {
  const rec = ownedTask(s, jobId);
  if (!rec) {
    sendProblem(res, problem({ type: "noTask", title: "task not found", status: 404, detail: jobId }));
    return true;
  }
  if (isTerminal(rec.status)) {
    sendJson(res, 200, { jobId, status: rec.status });
    return true;
  }
  cancelTask(s, rec);
  sendJson(res, 202, { jobId, status: "cancelled" });
  return true;
}

/**
 * Кооперативная отмена задачи: терминальный `cancelled`, сброс висящих вопросов,
 * `agent.shutdown` (если ход бежит/ждёт ввод). Идемпотентна к позднему `settleTask`
 * (статус уже терминален — `startTask` это увидит и не перезапишет).
 */
function cancelTask(s: AgentServiceState, task: TaskRecord): void {
  s.tasks.finish(task.jobId, { status: "cancelled" });
  emitEvent(s, task, "task.cancelled", {});
  sendWebhook(s, task);
  cancelTaskQuestions(s, task.jobId);
  try {
    s.pool.getRunner(task.sessionId)?.agent.shutdown(task.sessionId);
  } catch {
    /* cooperative cancel best-effort */
  }
}

/**
 * Отменяет бегущий интерактивный ход сессии; `false` — отменять нечего.
 * Идемпотентна: повторный вызов после терминального статуса — no-op.
 */
export function interruptSession(s: AgentServiceState, sessionId: string): boolean {
  const task = s.tasks
    .listForSession(sessionId)
    .find((t) => t.mode === "interactive" && (t.status === "running" || t.status === "waiting_input"));
  if (!task) return false;
  cancelTask(s, task);
  return true;
}

/** Закрытие SSE отменяет только интерактивную задачу сессии (job продолжается). */
export function abortInteractiveTask(s: AgentServiceState, sessionId: string): void {
  interruptSession(s, sessionId);
}

/** `POST /v1/tasks/:jobId/answer` — ответ на `question` интерактивной задачи. */
export async function answerTask(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  jobId: string,
): Promise<boolean> {
  const rec = ownedTask(s, jobId);
  if (!rec) {
    sendProblem(res, problem({ type: "noTask", title: "task not found", status: 404, detail: jobId }));
    return true;
  }
  if (rec.status !== "waiting_input") {
    sendProblem(res, problem({ type: "validation", title: "task is not waiting for input", status: 409, detail: rec.status }));
    return true;
  }
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    sendProblem(res, problem({ type: "validation", title: "question id required", status: 400 }));
    return true;
  }
  if (!resolveAnswer(s, id, body.answer, { taskId: jobId, sessionId: rec.sessionId })) {
    sendProblem(res, problem({ type: "validation", title: "unknown question id", status: 404, detail: id }));
    return true;
  }
  sendJson(res, 202, { jobId, status: "running" });
  return true;
}
