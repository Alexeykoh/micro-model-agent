/**
 * Отображение события прогона субагента в запись `session.jsonl`.
 *
 * Чистая функция без побочных эффектов: контракт записи проверяется тестом без
 * файлов на диске, а приёмник (`tool-context`) только зовёт `appendLog`.
 * Форма записи — `type: "subagent"` + `subagent: <runId>` (спека
 * `2026-10-27-subagent-run-journal-design`).
 */
import type { SessionLogEntry } from "../modules/session/store";
import type { SubagentRunEvent } from "./subagent-runs";

/** Задача в журнале — одной строкой: журнал должен грепаться, а не читаться. */
const TASK_MAX = 120;
/** Голова вывода тула: полное тело уже живёт в контексте/спиллах. */
const OUTPUT_MAX = 200;
/** Текст ошибки прогона. */
const ERROR_MAX = 300;

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Запись журнала для события прогона.
 * @returns `undefined` — событие не журналируется (текст/рассуждения/фаза).
 */
export function subagentLogEntry(event: SubagentRunEvent): SessionLogEntry | undefined {
  const base = { ts: new Date().toISOString(), type: "subagent" as const, source: "core" as const };

  switch (event.kind) {
    case "start":
      return {
        ...base,
        subagent: event.runId,
        content: "start",
        status: "running",
        tool: clip(event.task, TASK_MAX),
        args: {
          depth: event.depth,
          ...(event.agent ? { agent: event.agent } : {}),
          ...(event.model ? { model: event.model } : {}),
        },
      };
    case "tool_end":
      return {
        ...base,
        subagent: event.runId,
        content: "tool",
        tool: event.tool,
        success: event.success,
        ...(event.durationMs !== undefined ? { duration: event.durationMs } : {}),
        ...(event.output ? { summary: clip(event.output, OUTPUT_MAX) } : {}),
      };
    case "llm_usage":
      return {
        ...base,
        subagent: event.runId,
        content: "usage",
        ...(event.iteration !== undefined ? { iteration: event.iteration } : {}),
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.model ? { model: event.model } : {}),
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        ...(event.origin ? { origin: event.origin } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      };
    case "end":
      return {
        ...base,
        subagent: event.runId,
        content: "end",
        status: event.status,
        success: event.status === "done",
        duration: event.durationMs,
        iteration: event.iterations,
        ...(event.usage
          ? {
              promptTokens: event.usage.promptTokens,
              completionTokens: event.usage.completionTokens,
              totalTokens: event.usage.totalTokens,
            }
          : {}),
        ...(event.error ? { summary: clip(event.error, ERROR_MAX) } : {}),
      };
    default:
      // text / reasoning / note / phase / tool_start: тела не журналируем —
      // в журнал идут только факты, нужные для разбора прогона.
      return undefined;
  }
}
