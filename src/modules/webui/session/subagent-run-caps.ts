// Caps and text scrubbing for subagent runs (extracted from subagent-runs.ts).
import { redactContextSecrets } from "../../../core/api";
import { sanitizeOutputPlain } from "../../../ui/sanitize-output";
import type { SubagentRunEvent, SubagentRunUsage } from "../../../tools/subagent-runs";

/** Сколько прогонов сессии держим в памяти (старые завершённые вытесняются). */
export const SUBAGENT_RUNS_PER_SESSION = 12;
/** Потолок событий одного прогона. */
export const SUBAGENT_RUN_MAX_EVENTS = 1000;
/** Потолок суммарного текста прогона (текст + рассуждения + note). */
export const SUBAGENT_RUN_MAX_TEXT_CHARS = 120_000;
/** Потолок тела одного тула в прогоне. */
export const SUBAGENT_TOOL_OUTPUT_CAP = 4000;

/** Чистит пользовательский текст/вывод тем же конвейером, что и основной фид. */
export function cleanRunText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : sanitizeOutputPlain(redactContextSecrets(text));
}

/** Обрезает вывод тула с честным маркером (кап ниже основного фида). */
export function clipRunOutput(text: string): string {
  if (text.length <= SUBAGENT_TOOL_OUTPUT_CAP) return text;
  return `${text.slice(0, SUBAGENT_TOOL_OUTPUT_CAP)}\n… [truncated from ${text.length} chars]`;
}

/** Статус прогона на сервере (`running` до `end`). */
export type StoredRunStatus = "running" | "done" | "failed" | "interrupted";

/** Событие прогона на проводе: исходное событие + серверный `seq`. */
export type SubagentWireEvent = SubagentRunEvent & { seq: number };

/** Снимок прогона для REST/SSE (без внутренних буферов и таймеров). */
export interface SubagentRunSnapshot {
  runId: string;
  parentSessionId?: string;
  parentToolCallId?: string;
  depth: number;
  task: string;
  agent?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  status: StoredRunStatus;
  output?: string;
  error?: string;
  iterations?: number;
  usage?: SubagentRunUsage;
  events: SubagentWireEvent[];
}
