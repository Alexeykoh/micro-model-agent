/** Единая точка эмита envelope'ов задачи: seq, буфер resume, SSE-рассылка. */
import type { AgentServiceState } from "../state";
import type { TaskRecord } from "./task-registry";
import type { Envelope } from "./envelope";

/** Формат SSE-фрейма v1: `id` → `Last-Event-ID`, `event` → тип, `data` → envelope. */
export function formatFrame(env: Envelope): string {
  return `id: ${env.seq}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
}

/** Кап событий на задачу: реестр не растёт бесконечно на долгом ходе. */
export const TASK_EVENTS_MAX = 2000;

/** Аллоцирует seq, кладёт в буфер/задачу и рассылает подписчикам сессии. */
export function emitEvent(
  s: AgentServiceState,
  task: TaskRecord,
  type: string,
  data: unknown,
  attempt?: number,
): Envelope {
  const env: Envelope = {
    v: 1,
    seq: s.envelopes.next(task.sessionId),
    ts: Date.now(),
    type,
    sessionId: task.sessionId,
    taskId: task.jobId,
    ...(attempt !== undefined ? { attempt } : {}),
    data,
  };
  s.envelopes.append(env);
  task.events.push(env);
  if (task.events.length > TASK_EVENTS_MAX) {
    task.events.splice(0, task.events.length - TASK_EVENTS_MAX);
  }
  for (const client of s.clients) {
    if (client.sessionId === task.sessionId) client.send(formatFrame(env));
  }
  return env;
}
