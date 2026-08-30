import { t } from "../../i18n/index";
import {
  TOOL_RESULT_MAX_TOKENS_RATIO,
  TOOL_RESULT_ABSOLUTE_MAX_CHARS,
  TOOL_ARGS_SUMMARY_MAX_CHARS,
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
 * JSON-сериализация аргументов тула для <system-summary>, ограниченная по
 * размеру. Большой аргумент (content у write_file) не должен дублироваться в
 * сводке поверх role:"tool" сообщения, которое уже несёт результат.
 */
export function summarizeToolArgs(args: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  if (!s || s === "{}") return "";
  if (s.length <= TOOL_ARGS_SUMMARY_MAX_CHARS) return ` (${s})`;
  return ` (${s.slice(0, TOOL_ARGS_SUMMARY_MAX_CHARS)}…(${s.length} chars total))`;
}