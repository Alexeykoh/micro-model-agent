/**
 * Отвязка interactive-хода от последнего клиента (split W13).
 *
 * Спека §7.3 отменяет ход при закрытии последнего SSE-потока; §8 требует, чтобы
 * вопрос пережил переподключение. Компромисс — `service.detachedTurnGraceMs`:
 * 0 (дефолт) сохраняет старое поведение, >0 даёт окно на reconnect. Ход в этом
 * окне помечается `detached`; по истечении — отменяется с явным событием.
 */
import type { AgentServiceState } from "../state";
import { defaultOutputBus } from "../../../output";
import { emitEvent } from "../runtime/emit";
import type { TaskRecord } from "../runtime/task-registry";
import { abortInteractiveTask, cancelTask } from "./tasks-control";

/** Запись в шину наблюдаемости (INV-13): отвязка/истечение не молчат. */
function note(sessionId: string, text: string): void {
  defaultOutputBus.emit({
    level: "warn",
    source: "module:service",
    kind: "log",
    text,
    sessionId,
    data: { diagnostic: true },
  });
}

/** Текущий interactive-ход сессии в активной фазе. */
function activeInteractive(s: AgentServiceState, sessionId: string): TaskRecord | undefined {
  return s.tasks
    .listForSession(sessionId)
    .find((t) => t.mode === "interactive" && (t.status === "running" || t.status === "waiting_input"));
}

/** Есть ли у сессии живой SSE-подписчик (переподключение отменяет отвязку). */
function hasSubscribers(s: AgentServiceState, sessionId: string): boolean {
  for (const client of s.clients) if (client.sessionId === sessionId) return true;
  return false;
}

/** Последний клиент ушёл: отменить сразу (grace=0) или взвести таймер. */
export function detachInteractive(s: AgentServiceState, sessionId: string): void {
  if (hasSubscribers(s, sessionId)) return;
  const task = activeInteractive(s, sessionId);
  if (!task || task.detached) return;
  const grace = s.config.service.detachedTurnGraceMs ?? 0;
  if (grace <= 0) {
    abortInteractiveTask(s, sessionId);
    return;
  }
  task.detached = true;
  note(sessionId, `turn detached (grace ${grace} ms): ${task.jobId}`);
  emitEvent(s, task, "task.detached", { graceMs: grace });
  const timer = setTimeout(() => {
    s.detachedTimers.delete(sessionId);
    const current = activeInteractive(s, sessionId);
    if (!current?.detached || hasSubscribers(s, sessionId)) return;
    note(sessionId, `detached turn cancelled after grace: ${current.jobId}`);
    emitEvent(s, current, "task.detached_timeout", {});
    cancelTask(s, current);
  }, grace);
  timer.unref?.();
  s.detachedTimers.set(sessionId, timer);
}

/** Клиент вернулся: снять таймер и вернуть ход в обычный режим. */
export function attachInteractive(s: AgentServiceState, sessionId: string): void {
  const timer = s.detachedTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    s.detachedTimers.delete(sessionId);
  }
  const task = activeInteractive(s, sessionId);
  if (!task?.detached) return;
  task.detached = false;
  emitEvent(s, task, "task.attached", {});
}

/** Снять все таймеры при остановке сервиса. */
export function clearDetachedTimers(s: AgentServiceState): void {
  for (const timer of s.detachedTimers.values()) clearTimeout(timer);
  s.detachedTimers.clear();
}
