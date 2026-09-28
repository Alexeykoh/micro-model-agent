// input_from: нормализация ссылок и секция "входы от прошлых задач" в промпте.
import type { MoESubtask, SubtaskResult } from "./types";

/** Ссылка input_from: id подзадачи + опциональное поле. */
export interface InputFromRef {
  subtaskId: string;
  field?: string;
}

/**
 * Принимает обе формы input_from: компактную (`["task-1"]`) и детальную
 * (`[{"subtaskId": "task-1", "field": "json"}]`).
 */
export function normalizeInputFrom(input: unknown): InputFromRef[] {
  if (!Array.isArray(input)) return [];
  const refs: InputFromRef[] = [];
  for (const entry of input) {
    if (typeof entry === "string") {
      refs.push({ subtaskId: entry });
    } else if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.subtaskId === "string") {
        refs.push({
          subtaskId: obj.subtaskId,
          field: typeof obj.field === "string" ? obj.field : undefined,
        });
      }
    }
  }
  return refs;
}

function truncate(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= cap) return flat;
  return `${flat.slice(0, cap)}…`;
}

/**
 * Рендерит секцию "Input from previous tasks" для промпта зависимой
 * подзадачи. Упавшие зависимости помечаются явно, чтобы читатель не строил
 * логику на отсутствующих данных.
 */
export function buildInputSection(
  subtask: MoESubtask,
  depResults: Map<string, SubtaskResult>,
  maxChars: number,
): string {
  const refs = normalizeInputFrom(subtask.input_from);
  if (refs.length === 0) return "";

  // Агрегатный кап: без него 10 зависимостей × maxChars раздувают промпт
  // выше бюджета контекста маленькой модели.
  const totalCap = maxChars * 4;
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;

  for (const ref of refs) {
    const dep = depResults.get(ref.subtaskId);
    if (!dep) {
      const line = `- ${ref.subtaskId}: (no result available)`;
      lines.push(line);
      used += line.length;
      continue;
    }
    const label = ref.field ? `${ref.subtaskId}.${ref.field}` : ref.subtaskId;
    const body = dep.success
      ? truncate(dep.result || dep.summary, maxChars)
      : `[FAILED] ${truncate(dep.error || dep.summary || "unknown error", maxChars)}`;
    const line = `- ${label}: ${body}`;
    if (used + line.length > totalCap) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length;
  }

  if (omitted > 0) {
    lines.push(`- (${omitted} more input(s) omitted: input budget reached)`);
  }

  return `\n\nInput from previous tasks:\n${lines.join("\n")}`;
}
