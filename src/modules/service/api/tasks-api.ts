/**
 * `/v1/sessions/:id/tasks` и `/v1/tasks/:jobId[...]` (спека §6.2, §9).
 *
 * Задача = ход над сессией. Сабмит — single-flight через `RunPool`: занятая
 * сессия кладёт задачу в FIFO, свободная стартует сразу. `Idempotency-Key`
 * дедуплицирует повтор; `wait:true` синхронно ждёт до `service.syncWaitMs`.
 * Статус/результат читаются pull'ом; webhook — оптимизация (Фаза 7).
 *
 * Роутер и HTTP-контракт — здесь; разбор сабмита — `tasks-submit.ts`, прогон —
 * `tasks-runner.ts`, status/cancel/answer — `tasks-control.ts` (правило 6).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentServiceState } from "../state";
import { answerTask, cancelTaskRoute, taskStatus } from "./tasks-control";
import { submitTask } from "./tasks-submit";

export { abortInteractiveTask } from "./tasks-control";
export { toJobObject } from "./tasks-job";

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
    return submitTask(req, res, s, decodeURIComponent(parts[2]));
  }
  if (parts[1] === "tasks" && parts.length === 3 && req.method === "GET") {
    return taskStatus(res, s, decodeURIComponent(parts[2]));
  }
  if (parts[1] === "tasks" && parts.length === 4 && req.method === "POST") {
    const jobId = decodeURIComponent(parts[2]);
    if (parts[3] === "cancel") return cancelTaskRoute(res, s, jobId);
    if (parts[3] === "answer") return answerTask(req, res, s, jobId);
  }
  return false;
}
