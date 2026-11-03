/**
 * Публичные и внутренние типы строчного редактора. Вынесены из
 * `line-editor.ts` (правило 6) и реэкспортируются оттуда — внешний контракт
 * (`LineInput`, `CompletionItem`, `LineEditorOptions`) не менялся.
 */

/** Входная строка хоста (REPL): промпт, вопрос, печать поверх. */
export interface LineInput {
  setPrompt(prompt: string): void;
  prompt(preserveCursor?: boolean): void;
  write(s: string): void;
  question(query: string, cb: (answer: string) => void): void;
  close(): void;
  printAbove?(text: string): void;
  on(event: "line", listener: (line: string) => void): this;
  on(event: "close", listener: () => void): this;
}

/** Вариант автокомплита: значение + опц. описание. */
export interface CompletionItem {
  value: string;
  description?: string;
}

/** Опции редактора: потоки, промпт, комплитер, история, обработчик Ctrl+C. */
export interface LineEditorOptions {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  output: NodeJS.WritableStream & { columns?: number };
  prompt?: string;
  completer?: (line: string, cursor?: number) => [CompletionItem[], string];
  history?: string[];
  historySize?: number;
  tabSize?: number;
  /**
   * Обработчик Ctrl+C. Дефолт: эмитит "SIGINT", если есть слушатель (REPL его
   * ставит). Инжектится, чтобы тесты не слали процессные сигналы: под нагрузкой
   * настоящий SIGINT может убить весь тест-раннер.
   */
  onInterrupt?: () => void;
}

export interface EditorListeners {
  line?: (line: string) => void;
  close?: () => void;
}

export type EditorOutput = LineEditorOptions["output"];
