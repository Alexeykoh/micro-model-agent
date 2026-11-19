/**
 * Эскалация повторных провалов по паре «тул + цель»: structural-сигналы
 * (`ToolResult.success` + каноническая цель), никакого разбора текста ошибок.
 *
 * Модель, которая трижды провалила `edit_file` одного пути, получает директиву
 * перечитать файл — иначе она правит по устаревшему снимку (сессия ses_mwmeoln9:
 * 23 ответа edit_file с Project typecheck failed).
 */
import { t } from "../../i18n/index";
import type { ToolCall } from "../types";
import type { ToolResult } from "../../tools/types";
import { TARGET_FAILURE_NUDGE_THRESHOLD } from "./constants";
import type { LoopState } from "./loop-state";

/** Канонический ключ цели: тул + стабильные аргументы, без текста ошибки. */
export function toolTargetKey(call: ToolCall): string {
  const path = call.arguments?.path;
  const target =
    typeof path === "string"
      ? `path:${path}`
      : typeof call.arguments?.command === "string"
        ? `cmd:${call.arguments.command}`
        : "none";
  return `${call.name}:${target}`;
}

/**
 * Учитывает результат вызова и возвращает директиву ровно один раз на цель,
 * когда число провалов подряд достигает порога. Успех сбрасывает счётчик.
 */
export function recordToolTargetFailure(
  state: LoopState,
  call: ToolCall,
  result: ToolResult,
): string | null {
  const key = toolTargetKey(call);
  if (result.success) {
    state.toolTargetFailures.delete(key);
    return null;
  }
  const count = (state.toolTargetFailures.get(key) ?? 0) + 1;
  state.toolTargetFailures.set(key, count);
  if (count < TARGET_FAILURE_NUDGE_THRESHOLD || state.targetFailureNudged.has(key)) return null;
  state.targetFailureNudged.add(key);
  const path = call.arguments?.path;
  return t("exec.target_failure_nudge", {
    tool: call.name,
    target: typeof path === "string" ? path : toolTargetKey(call),
  });
}
