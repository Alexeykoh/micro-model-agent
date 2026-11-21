/**
 * RCV-1: единая классификация детерминированных ошибок ввода/политики.
 *
 * Такие ответы не означают, что тул сломан: модель передала неверные аргументы
 * (запрещённый оператор, несуществующий id, план без обязательных файлов).
 * Они уже несут actionable-подсказку и не должны отключать тул или питать
 * stall-терминал — иначе модель теряет способ выполнить задачу.
 */
import type { ToolResult } from "../../tools/types";

const VALIDATION_MARKERS = [
  "[SECURITY BLOCKED]",
  "Process not found:",
  "does not cover files required",
] as const;

export function isValidationFailure(result: ToolResult): boolean {
  if (result.blocked || result.errorMeta?.retryable === false) return true;
  const output = String(result.output ?? "");
  return VALIDATION_MARKERS.some((marker) => output.includes(marker));
}
