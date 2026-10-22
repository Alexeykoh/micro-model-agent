/**
 * Детекция повторных одинаковых тулов (структурная).
 *
 * Вынесено из `loop-llm.ts` (правило 6). Сигнал питает reasoning policy
 * (понижение effort на рутине) и жёсткий стоп петли по status-тулам.
 */
import type { ToolCall } from "../../tools/types";
import type { LoopState } from "./loop-state";
import { canonicalArgsKey } from "./canonical-args";
import {
  MAX_REPEATED_TOOL_CALLS,
  MAX_REPEATED_TOOL_CALLS_INTERACTIVE,
} from "./constants";

/**
 * Read-only тулы-интроспекции. Повтор одного с теми же аргументами прогресса
 * не даст никогда, поэтому интерактивный цикл жёстко стопает после нескольких
 * повторов (наблюдалось: `session_info` в тугом цикле после готовой задачи).
 * Мутирующие — только nudge, чтобы легитимный edit/build/read-цикл не резать.
 */
const LOOP_PRONE_STATUS_TOOLS = new Set([
  "session_info",
  "process_list",
  "process_log",
  "file_info",
  "project_map",
]);

/** Итог детекции повтора: нужно ли остановить ход. */
export interface RepeatDetection {
  /** Вызов повторился (директива уже выдана). */
  repeated: boolean;
  /** Ход надо прервать (жёсткий стоп). */
  stop: boolean;
}

/**
 * Считает повтор и решает, пора ли остановить ход. Директиву модели
 * (`repeated_call`) ставит вызывающий — здесь только счётчики и решение.
 */
export function detectRepeatedToolCall(
  state: LoopState,
  toolCalls: ToolCall[],
  exitOnComplete: boolean,
): RepeatDetection {
  // Каноническая подпись: порядок ключей и `./a.ts` vs `a.ts` не должны
  // выглядеть «новым» вызовом (§1.9 аудита — раньше был сырой JSON.stringify).
  const signature = toolCalls
    .map((tc) => canonicalArgsKey(tc.name, tc.arguments))
    .join("|");
  if (!signature || signature !== state.lastToolSignature) {
    state.repeatedToolCount = 0;
    state.lastToolSignature = signature;
    return { repeated: false, stop: false };
  }
  state.iterRepetitive = true;
  state.repeatedToolCount++;
  state.lastToolSignature = signature;
  // Жёсткий стоп — только для status-тулов, которые не прогрессируют от
  // повтора. Мутирующие/побочные (напр. bash) остаются nudge-only.
  const allStatusTools = toolCalls.every((tc) => LOOP_PRONE_STATUS_TOOLS.has(tc.name));
  if (!allStatusTools) return { repeated: true, stop: false };
  if (exitOnComplete) {
    return { repeated: true, stop: state.repeatedToolCount >= MAX_REPEATED_TOOL_CALLS };
  }
  return {
    repeated: true,
    stop: state.repeatedToolCount >= MAX_REPEATED_TOOL_CALLS_INTERACTIVE,
  };
}
