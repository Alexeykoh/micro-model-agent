/**
 * Отображение события прогона субагента в запись `session.jsonl`.
 *
 * Чистая функция без побочных эффектов: контракт записи проверяется тестом без
 * файлов на диске, а приёмник (`tool-context`) только зовёт `appendLog`.
 * Форма записи — `type: "subagent"` + `subagent: <runId>` (спека
 * `2026-10-27-subagent-run-journal-design`).
 */
import type { SessionLogEntry } from "../modules/session/store";
import { redactContextSecrets } from "../core/agent/context-log";
import type { SubagentRunEvent } from "./subagent-runs";

/** Задача в журнале — одной строкой: журнал должен грепаться, а не читаться. */
const TASK_MAX = 120;
/** Голова вывода тула: полное тело уже живёт в контексте/спиллах. */
const OUTPUT_MAX = 200;
/** Текст ошибки прогона. */
const ERROR_MAX = 300;
/** Значение аргумента тула в журнале: путь виден, тело файла — нет. */
const ARG_MAX = 200;

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Аргументы тула для журнала: строковые значения ужаты до одной строки
 * `ARG_MAX`, секреты отредактированы тем же правилом, что и тела сообщений
 * (INV-DLP: оригиналы в лог не попадают).
 */
function journalArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out[key] = clip(value, ARG_MAX);
    else if (Array.isArray(value)) {
      out[key] = value.slice(0, 20).map((v) => (typeof v === "string" ? clip(v, ARG_MAX) : v));
    } else out[key] = value;
  }
  try {
    return JSON.parse(redactContextSecrets(JSON.stringify(out))) as Record<string, unknown>;
  } catch {
    return {};
  }
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
    case "tool_start":
      // Аргументы — с самого начала вызова: по `tool_end` не понять, с каким
      // путём/файлом он упал (сессия ses_mvqwky8y). Секреты редактируются.
      return {
        ...base,
        subagent: event.runId,
        content: "tool_start",
        tool: event.tool,
        args: journalArgs(event.args),
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
        // Здоровье прогона (A7): по журналу видно, работал ли прогон вообще.
        ...(event.health
          ? {
              toolsOk: event.health.toolsOk,
              toolsFailed: event.health.toolsFailed,
              filesRead: event.health.filesRead,
              filesWritten: event.health.filesWritten,
              blocked: event.health.blocked,
            }
          : {}),
      };
    default:
      // text / reasoning / note / phase: тела не журналируем — в журнал идут
      // только факты, нужные для разбора прогона.
      return undefined;
  }
}
