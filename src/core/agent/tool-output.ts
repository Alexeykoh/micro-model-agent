import { t } from "../../i18n/index";
import {
  TOOL_RESULT_MAX_TOKENS_RATIO,
  TOOL_RESULT_ABSOLUTE_MAX_CHARS,
  TOOL_ARGS_SUMMARY_MAX_CHARS,
  TOOL_ARG_VALUE_MAX_CHARS,
} from "./constants";

/**
 * Макс. число символов результата тула при заданном остатке бюджета и
 * признаке того, что тул сам ограничивает свой вывод.
 *
 * Тулы с `boundedOutput` (например, read_file с лимитом строк) НИКОГДА не
 * усекаются бюджетом — почти полный контекст раньше резал их до ~2K символов,
 * и модель верила, что файлы обрезаны, перечитывая их бесконечно.
 */
export function toolOutputCharLimit(
  remainingBudget: number,
  historyBudget: number,
  bounded: boolean,
): number {
  if (bounded) return Number.MAX_SAFE_INTEGER;
  const maxCharsByRatio = Math.floor(historyBudget * TOOL_RESULT_MAX_TOKENS_RATIO * 2);
  return Math.min(remainingBudget, maxCharsByRatio, TOOL_RESULT_ABSOLUTE_MAX_CHARS);
}

/** Усечение вывода тула под бюджет с честной пометкой о потере. */
export function truncateToolOutput(
  output: string,
  budget: { history: number },
  currentTokens: number,
  bounded: boolean,
): string {
  const remainingBudget = Math.max(0, budget.history - currentTokens);
  const maxChars = toolOutputCharLimit(remainingBudget, budget.history, bounded);
  if (output.length <= maxChars) return output;
  const truncated = output.slice(0, maxChars);
  const removedChars = output.length - maxChars;
  return truncated + `\n\n${t("tool.truncated", { tokens: Math.ceil(removedChars / 2) })}`;
}

/**
 * Компактная сигнатура аргументов тула для <system-summary>.
 *
 * Длинные строковые значения (content/new_string/text/…) сворачиваются до
 * `…(N chars)`: их полный текст уже есть в assistant-сообщении с tool_calls
 * и в role:"tool" результате, поэтому дублировать тело в сводке не нужно.
 * Короткие скаляры (path/command/pattern/url) сохраняются как есть.
 * Реализация не привязана к конкретным тулам — правило общее для любых args.
 */
export function summarizeToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") {
    const s = String(args);
    return s ? ` (${s.slice(0, TOOL_ARGS_SUMMARY_MAX_CHARS)})` : "";
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    let rendered: string;
    if (typeof value === "string") {
      rendered =
        value.length > TOOL_ARG_VALUE_MAX_CHARS
          ? `${key}:…(${value.length} chars)`
          : `${key}:${value}`;
    } else {
      let json: string;
      try {
        json = JSON.stringify(value);
      } catch {
        json = String(value);
      }
      rendered =
        json && json.length > TOOL_ARG_VALUE_MAX_CHARS ? `${key}:…` : `${key}:${json}`;
    }
    parts.push(rendered);
    if (parts.join(", ").length > TOOL_ARGS_SUMMARY_MAX_CHARS) break;
  }

  const s = parts.join(", ");
  if (!s) return "";
  if (s.length <= TOOL_ARGS_SUMMARY_MAX_CHARS) return ` (${s})`;
  return ` (${s.slice(0, TOOL_ARGS_SUMMARY_MAX_CHARS)}…(${s.length} chars total))`;
}

/**
 * Является ли путь исполняемым shell-скриптом (обёрткой). Обобщённо, без
 * привязки к языку проекта: используется, чтобы заметить попытку обойти
 * security-блокировку через свежесозданный скрипт.
 */
export function isExecutableScriptPath(filePath: string): boolean {
  return /\.[a-z0-9]+$/i.test(filePath) && /\.(bat|cmd|sh|bash|ps1|zsh|fish)$/i.test(filePath);
}

/**
 * Компактная пользовательская строка для упавшего тула.
 *
 * Полный `result.output` — это model-facing текст: хвост с Hint / recovery /
 * "Do NOT …" инструкциями. В чат он попадать не должен: пользователю нужна
 * суть ошибки (первая непустая строка), обрезанная по длине.
 */
export function compactToolError(output: unknown, max = 200): string {
  const text = String(output ?? "");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
  }
  return "";
}
