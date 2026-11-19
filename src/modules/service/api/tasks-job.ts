/**
 * Общие примитивы задач сервиса: Job-проекция, URL статуса, разбор тела и
 * tenant-контекст. Вынесено из `tasks-api.ts` (правило 6, ≤300 строк).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBodyOrProblem } from "../http/respond";
import type { TaskRecord, TenantContext } from "../runtime/task-registry";
import type { AgentServiceState } from "../state";
import type { JobObject } from "../types";

/** Кап тела JSON-запроса сервиса (задачи текстовые, картинок тут нет). */
export const MAX_JSON_BYTES = 1024 * 1024;

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

export function statusUrl(jobId: string): string {
  return `/v1/tasks/${jobId}`;
}

/** Тело JSON-запроса как объект (пусто/бито → `{}`). */
export async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  return readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
}

/** Tenant/run-контекст задачи: тенант — из процесса, остальное — audit-метки (§11). */
export function tenantOf(req: IncomingMessage, s: AgentServiceState): TenantContext {
  const principalId = headerString(req, "x-mma-principal");
  const runId = headerString(req, "x-mma-run");
  return {
    ...(s.tenant.tenantId ? { tenantId: s.tenant.tenantId } : {}),
    ...(principalId ? { principalId } : {}),
    ...(runId ? { runId } : {}),
  };
}

export function headerString(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}
