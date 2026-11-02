/**
 * Здоровье прогона субагента (A7): счётчики тулов и файлов, которые попадают
 * в `end`-событие, журнал и текст результата.
 *
 * Зачем: 5/5 прогонов в живой сессии отдавали `success:true` при 38 падениях из
 * 60 вызовов и нуле чтений у двух — родитель не мог отличить работу от
 * «рассказал, что сделал». Счётчики делают это проверяемым.
 */
import { t } from "../i18n/index";

export interface RunHealth {
  toolsOk: number;
  toolsFailed: number;
  filesRead: number;
  filesWritten: number;
  blocked: number;
}

export const EMPTY_HEALTH: RunHealth = {
  toolsOk: 0,
  toolsFailed: 0,
  filesRead: 0,
  filesWritten: 0,
  blocked: 0,
};

/** Тулы чтения: успешный вызов = прогон действительно смотрел на файлы. */
const READ_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "list_dir",
  "file_info",
  "chunk_query",
  "scan_corpus",
]);

/** Тулы записи: успешный вызов = в проекте что-то изменилось. */
const WRITE_TOOLS = new Set(["write_file", "edit_file", "append_file"]);

/**
 * Аналитическая задача — та, где модель обязана была что-то прочитать.
 * Эвристика по глаголам задачи (en/ru): точность здесь не критична — проверка
 * срабатывает только при НУЛЕ прочитанных файлов, то есть когда прогон ничего
 * не смотрел вообще.
 */
export function isAnalyticalTask(task: string): boolean {
  return /\b(read|analy[sz]e|inspect|review|check|find|search|look|examine|explore)\b|прочит|проанализ|провер|найд|поиск|изуч|посмотр|рассмотр/i.test(
    task,
  );
}

/** Строка здоровья для текста результата (видит родительская модель). */
export function healthLine(h: RunHealth): string {
  return `[run health: tools ${h.toolsOk} ok / ${h.toolsFailed} failed · files read ${h.filesRead} · written ${h.filesWritten} · blocked ${h.blocked}]`;
}

/** Учесть завершение тула в счётчиках прогона. */
export function recordToolOutcome(
  health: RunHealth,
  tool: string,
  success: boolean,
  output?: string,
): void {
  if (success) health.toolsOk++;
  else health.toolsFailed++;
  if (!success && /SECURITY BLOCKED/i.test(output ?? "")) health.blocked++;
  if (!success) return;
  if (READ_TOOLS.has(tool)) health.filesRead++;
  if (WRITE_TOOLS.has(tool)) health.filesWritten++;
}

/**
 * Причина отказа для «аналитической задачи без единого чтения» (A7).
 * `undefined` — успех допустим.
 */
export function emptyRunFailure(task: string, health: RunHealth): string | undefined {
  if (!isAnalyticalTask(task) || health.filesRead > 0) return undefined;
  return t("tool.subagent_no_reads", { tools: String(health.toolsOk + health.toolsFailed) });
}
