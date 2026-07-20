import type { OutputRenderer } from '../ui/renderer.js';

/**
 * Общие типы для системы инструментов.
 *
 * Единый интерфейс ToolHandler используется всеми инструментами:
 * - FS (read_file, write_file и т.д.)
 * - Bash
 * - Web (search, fetch)
 * - Native (plan, todo, question, approve, theme, user_profile)
 *
 * @module tools/types
 */

/** Контекст выполнения — передаётся в каждый ToolHandler */
export interface ToolContext {
  /** Рабочая директория */
  cwd: string;
  /** Рендерер для UI-вывода (нативные инструменты) */
  renderer?: OutputRenderer;
  /** Тихий режим (без вывода в UI) */
  quiet?: boolean;
  /** Колбэк для question/approve — приостанавливает цикл */
  onQuestion?: () => void;
}

/** Результат выполнения инструмента */
export interface ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  /** Инструмент ожидает ответа (question/approve) — цикл приостанавливается */
  questionPending?: boolean;
  /** Прервать ReAct-цикл после этого результата */
  breakLoop?: boolean;
}

/** Единый интерфейс обработчика инструмента */
export interface ToolHandler {
  /** Уникальное имя инструмента (например 'read_file', 'bash', 'plan') */
  name: string;
  /** Определение для LLM (name, description, parameters) */
  definition: ToolDefinition;
  /** Выполнение инструмента */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** Определение инструмента для LLM */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Инструментальный вызов из LLM ( до валидации) */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
