/** Единая точка эмита envelope'ов задачи: seq, буфер resume, SSE-рассылка. */
import type { AgentServiceState } from "../state";
import type { TaskRecord } from "./task-registry";
import type { Envelope } from "./envelope";

/** Формат SSE-фрейма v1: `id` → `Last-Event-ID`, `event` → тип, `data` → envelope. */
export function formatFrame(env: Envelope): string {
  return `id: ${env.seq}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
}

/** Аллоцирует seq, кладёт в буфер/задачу и рассылает подписчикам сессии. */
export function emitEvent(
  s: AgentServiceState,
  task: TaskRecord,
  type: string,
  data: unknown,
): Envelope {
  const env: Envelope = {
    v: 1,
    seq: s.envelopes.next(task.sessionId),
    ts: Date.now(),
    type,
    sessionId: task.sessionId,
    taskId: task.jobId,
    data,
  };
  s.envelopes.append(env);
  task.events.push(env);
  for (const client of s.clients) {
    if (client.sessionId === task.sessionId) client.send(formatFrame(env));
  }
  return env;
}
