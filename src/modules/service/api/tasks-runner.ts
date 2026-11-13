/**
 * Жизненный цикл прогона задачи: резерв слота, старт, терминальные переходы,
 * таймаут, drain очереди и webhook. Вынесено из `tasks-api.ts` (правило 6).
 */
import type { SessionRunner } from "../../../core/bootstrap/session-runner";
import { defaultOutputBus } from "../../../output";
import { errMsg } from "../../../utils/error";
import { apiGuard } from "../../../runtime/egress";
import { emitEvent } from "../runtime/emit";
import { makeServiceForwarder } from "../runtime/event-bridge";
import { newEventId } from "../runtime/ids";
import { problem, type ProblemDetails } from "../runtime/problem";
import { installServicePromptIO } from "../runtime/prompt-io";
import { runTask, type RunTaskResult } from "../runtime/run-task";
import { isTerminal, type TaskRecord, type TenantContext } from "../runtime/task-registry";
import { deliverWebhook } from "../runtime/webhook";
import type { AgentServiceState } from "../state";
import { toJobObject } from "./tasks-job";

/** Резервирует слот сессии и стартует задачу (fire-and-forget, отказ — в статус). */
export function reserveAndStart(s: AgentServiceState, task: TaskRecord): void {
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
  for (const url of task.images ?? []) {
    (runner.contextManager as { addPendingImage?: (img: unknown) => void } | undefined)?.addPendingImage?.({
      type: "image_url",
      image_url: { url },
    });
  }
  logTaskContext(runner, task);

  const forwarder = makeServiceForwarder({
    emit: (type, data, attempt) => emitEvent(s, task, type, data, attempt),
  });
  const disarmTimeout = armTimeout(task, runner);

  try {
    const result = await runTask({
      runner,
      task,
      forwarder,
      onPlan: (plan) => emitEvent(s, task, "plan", { steps: plan.steps, currentIndex: plan.currentIndex }),
    });
    concludeTask(s, task, result, disarmTimeout());
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

/** Терминальный переход по итогу хода: отмена/таймаут/успех/провал. */
function concludeTask(
  s: AgentServiceState,
  task: TaskRecord,
  result: RunTaskResult,
  disarmed: boolean,
): void {
  if (isCancelled(s, task)) return;
  if (disarmed) {
    finishFailure(
      s,
      task,
      problem({ type: "timeout", title: "task timed out", status: 408, detail: `timeoutMs=${task.timeoutMs ?? 0}` }),
    );
    return;
  }
  settleTask(s, task, result);
}

/** Пишет tenant/run-контекст задачи в журнал сессии (аудит, спека §10.3). */
function logTaskContext(runner: SessionRunner, task: TaskRecord): void {
  const tenant = task.tenant ?? {};
  const parts = [`task ${task.jobId} (${task.mode})`, ...tenantParts(tenant)];
  if (task.toolAllowlist?.length) parts.push(`allowlist=${task.toolAllowlist.join(",")}`);
  try {
    runner.sessionManager.appendLog({
      ts: new Date().toISOString(),
      type: "service_task",
      source: "module:service",
      module: "service",
      content: parts.join(" "),
      ...tenantFields(tenant),
      jobId: task.jobId,
    });
  } catch {
    /* журнал best-effort: не роняем ход из-за аудита */
  }
}

/** Человекочитаемые tenant-сегменты для `content` журнала. */
function tenantParts(tenant: TenantContext): string[] {
  const parts: string[] = [];
  if (tenant.tenantId) parts.push(`tenant=${tenant.tenantId}`);
  if (tenant.principalId) parts.push(`principal=${tenant.principalId}`);
  if (tenant.runId) parts.push(`run=${tenant.runId}`);
  return parts;
}

/** Структурные tenant-поля записи журнала. */
function tenantFields(
  tenant: TenantContext,
): Pick<import("../../session/store").SessionLogEntry, "tenantId" | "principalId" | "runId"> {
  return {
    ...(tenant.tenantId ? { tenantId: tenant.tenantId } : {}),
    ...(tenant.principalId ? { principalId: tenant.principalId } : {}),
    ...(tenant.runId ? { runId: tenant.runId } : {}),
  };
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
  if (result.forbidden) {
    finishFailure(
      s,
      task,
      problem({ type: "toolForbidden", title: "interactive tool not allowed in job mode", status: 403 }),
    );
    return;
  }
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
export function sendWebhook(s: AgentServiceState, task: TaskRecord): void {
  const rec = s.tasks.get(task.jobId);
  if (!rec?.callbackUrl || !isTerminal(rec.status)) return;
  void deliverWebhook({
    url: rec.callbackUrl,
    secret: s.config.service.webhookSecret,
    eventId: newEventId(),
    body: JSON.stringify(toJobObject(rec)),
    egress: apiGuard({ config: s.config, workspace: s.deps.baseDir }),
    timeoutMs: s.config.service.callbackTimeoutMs,
    networkConfig: s.config.security?.network,
    allowHttp: s.config.service.webhookAllowHttp ?? false,
    onDiagnostic: (diag) => {
      defaultOutputBus.log("warn", diag.source, `${diag.operation}: ${diag.cause}`, {
        diagnostic: true,
      });
    },
    ...(s.deps.webhookFetch ? { fetchImpl: s.deps.webhookFetch } : {}),
  }).catch(() => {
    /* pull доступен и при недоставке push */
  });
}
