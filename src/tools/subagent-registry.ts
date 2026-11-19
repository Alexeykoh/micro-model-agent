/**
 * Процессный реестр активных и недавних прогонов субагентов.
 *
 * Нужен тулам `subagent_list` / `subagent_stop`: модель должна видеть, какие
 * субагенты реально работают, и уметь остановить конкретный прогон, а не
 * путать их с shell-процессами (`process_list`).
 *
 * Реестр — локальное состояние одного процесса (MMA работает в модели
 * «один пользователь — один процесс»); записи привязаны к родительской сессии
 * и фильтруются по ней. Завершённые прогоны вытесняются по капу.
 */
import type { SubagentRunUsage } from "./subagent-runs";

export type RegisteredSubagentStatus = "running" | "done" | "failed" | "interrupted";

/** Публичное описание прогона для тулов. */
export interface RegisteredSubagent {
  runId: string;
  parentSessionId?: string;
  task: string;
  agent?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  status: RegisteredSubagentStatus;
  iterations?: number;
  error?: string;
  usage?: SubagentRunUsage;
}

interface Entry extends RegisteredSubagent {
  stop?: () => void;
}

/** Сколько записей хранить: активные не вытесняются, завершённые — да. */
const MAX_ENTRIES = 50;

const runs = new Map<string, Entry>();

/** Регистрирует старт прогона; возвращает false, если такой id уже есть. */
export function registerSubagentRun(entry: Omit<RegisteredSubagent, "status">): boolean {
  if (runs.has(entry.runId)) return false;
  runs.set(entry.runId, { ...entry, status: "running" });
  evict();
  return true;
}

/** Привязывает ручку остановки к прогону (зовёт `subagent_stop`). */
export function setSubagentRunStop(runId: string, stop: () => void): void {
  const run = runs.get(runId);
  if (run) run.stop = stop;
}

/** Завершает прогон: статус, токены, ошибка. */
export function finishSubagentRun(
  runId: string,
  patch: Partial<
    Pick<
      RegisteredSubagent,
      "status" | "endedAt" | "iterations" | "error" | "usage" | "model" | "agent"
    >
  >,
): void {
  const run = runs.get(runId);
  if (!run) return;
  Object.assign(run, patch);
  run.stop = undefined;
}

/** Прогоны сессии (новые последними); без sessionId — все. */
export function listSubagentRuns(sessionId?: string): RegisteredSubagent[] {
  const list: RegisteredSubagent[] = [];
  for (const run of runs.values()) {
    if (sessionId !== undefined && run.parentSessionId !== sessionId) continue;
    const { stop: _stop, ...pub } = run;
    list.push({ ...pub });
  }
  return list.sort((a, b) => a.startedAt - b.startedAt);
}

/** Останавливает прогон; `not_found` — чужой/неизвестный, `not_running` — уже кончился. */
export function stopSubagentRun(
  runId: string,
  sessionId?: string,
): "ok" | "not_found" | "not_running" {
  const run = runs.get(runId);
  if (!run) return "not_found";
  if (sessionId !== undefined && run.parentSessionId !== sessionId) return "not_found";
  if (run.status !== "running" || !run.stop) return "not_running";
  run.stop();
  return "ok";
}

/** Удаляет запись (например, при удалении сессии). */
export function forgetSubagentRun(runId: string): void {
  runs.delete(runId);
}

/** Только для тестов: очищает реестр. */
export function resetSubagentRegistry(): void {
  runs.clear();
}

/** Держит кап: сначала вытесняются самые старые завершённые прогоны. */
function evict(): void {
  if (runs.size <= MAX_ENTRIES) return;
  const finished = [...runs.values()]
    .filter((run) => run.status !== "running")
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  while (runs.size > MAX_ENTRIES && finished.length > 0) {
    runs.delete(finished.shift()!.runId);
  }
}
