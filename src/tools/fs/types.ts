import type { ToolResult } from '../registry.js';

/**
 * Общие типы и утилиты для файловых инструментов.
 *
 * @module tools/fs/types
 */

export type FsToolResult = ToolResult;

/** Создаёт результат ошибки для fs-инструмента */
export function fsError(message: string): FsToolResult {
  return { stdout: '', stderr: message, exitCode: 1, truncated: false };
}

/** Создаёт успешный результат для fs-инструмента */
export function fsOk(stdout: string, truncated = false): FsToolResult {
  return { stdout, stderr: '', exitCode: 0, truncated };
}

export const MAX_OUTPUT_CHARS = 16000; // максимальный вывод (символы)
export const MAX_LINE_COUNT = 500; // максимальный вывод (строки)
