/**
 * Создание редактора ввода REPL: TTY — `LineEditor` (raw, история, Tab),
 * не-TTY/пайп — обычный `readline`.
 *
 * Вынесено из `repl.ts` (правило 6): обе ветки дают один `LineInput`.
 */
import * as readline from "readline";
import { LineEditor, type LineInput } from "../ui/line-editor";
import type { CompletionItem, Completer } from "./completer";

/** Поля, нужные конструктору ввода. */
export interface ReplEditorOptions {
  completer: Completer;
  history: string[];
  maxHistory: number;
  prompt: string;
}

export function createReplEditor(opts: ReplEditorOptions): LineInput {
  const editorCompleter = (line: string, cursor?: number): [CompletionItem[], string] => {
    const [matches, partial] = opts.completer.complete(line, cursor);
    if (matches.length > 0) return [matches, partial];
    return [[], line];
  };
  // Комплитер node-readline понимает только plain-строковые совпадения.
  const readlineCompleter = (line: string): [string[], string] => {
    const [items, partial] = editorCompleter(line);
    return [items.map((i) => i.value), partial];
  };

  if (process.stdin.isTTY) {
    return new LineEditor({
      input: process.stdin,
      output: process.stdout,
      prompt: opts.prompt,
      history: opts.history,
      historySize: opts.maxHistory,
      completer: editorCompleter,
    });
  }
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: opts.prompt,
    history: opts.history,
    historySize: opts.maxHistory,
    tabSize: 2,
    completer: readlineCompleter,
  });
}
