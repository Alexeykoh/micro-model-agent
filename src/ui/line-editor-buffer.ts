/**
 * Буфер строки редактора: строки/курсор, примитивы правки и токен автокомплита.
 * Навигация и история — в `line-editor-nav.ts` (вынесено из `line-editor.ts`,
 * правило 6). Каждая операция сама зовёт `render` после мутации, как раньше.
 */
import { charLen } from "./line-math";
import type { CompletionItem } from "./line-editor-types";

export interface Stash {
  lines: string[];
  row: number;
  col: number;
}

/** Активная Tab-сессия комплита. Пока стоит, ↑/↓/Tab крутят кандидатов, а
 *  Esc возвращает `original`; любая другая клавиша сессию роняет. */
export interface CompletionSession {
  items: CompletionItem[];
  index: number;
  /** UTF-16 индекс в строке буфера, где начинается дополняемый токен. */
  from: number;
  /** Исходный частичный ввод, который заменили. */
  original: string;
  /** Сейчас вставленное значение-кандидат. */
  inserted: string;
}

/** Многострочный буфер ввода с состоянием комплита. */
export class LineBuffer {
  lines: string[] = [""];
  row = 0;
  col = 0;
  history: string[];
  historyIndex = -1;
  stash: Stash | null = null;
  completion: CompletionSession | null = null;
  readonly historySize: number;
  readonly render: () => void;

  constructor(history: string[], historySize: number, render: () => void) {
    this.history = history;
    this.historySize = historySize;
    this.render = render;
    if (this.history.length > this.historySize) {
      this.history = this.history.slice(-this.historySize);
    }
  }

  /** Сбрасывает буфер, историю-курсор и сессию комплита (рендер — у вызывающего). */
  reset(): void {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.historyIndex = -1;
    this.stash = null;
    this.completion = null;
  }

  /** Текст буфера построчно (как уходит в строку ввода). */
  text(): string {
    return this.lines.join("\n");
  }

  /** True, если в буфере ровно одна пустая строка. */
  isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0] === "";
  }

  private currentChars(): string[] {
    return Array.from(this.lines[this.row]);
  }

  private setCurrentChars(chars: string[]): void {
    this.lines[this.row] = chars.join("");
  }

  insertText(text: string): void {
    this.completion = null;
    const sanitized = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
    const chars = this.currentChars();
    const t = Array.from(sanitized);
    chars.splice(this.col, 0, ...t);
    this.setCurrentChars(chars);
    this.col += t.length;
    this.render();
  }

  /** Пакетная вставка текста под курсор. Режет по переводам строк, чтобы буфер
   *  держал строку на элемент (а не литеральные `\n`), и рендерит один раз:
   *  вставка должна выглядеть вставкой, а не печатью. */
  insertPaste(text: string): void {
    const segments = text.split("\n");
    if (segments.length === 1) {
      this.insertText(segments[0]);
      return;
    }
    const chars = this.currentChars();
    const head = chars.slice(0, this.col).join("");
    const tail = chars.slice(this.col).join("");
    const lines: string[] = [head + segments[0]];
    for (let i = 1; i < segments.length - 1; i++) lines.push(segments[i]);
    lines.push(segments[segments.length - 1] + tail);
    this.lines.splice(this.row, 1, ...lines);
    this.row += segments.length - 1;
    this.col = charLen(segments[segments.length - 1]);
    this.render();
  }

  insertNewline(): void {
    const chars = this.currentChars();
    const rest = chars.slice(this.col).join("");
    this.setCurrentChars(chars.slice(0, this.col));
    this.lines.splice(this.row + 1, 0, rest);
    this.row++;
    this.col = 0;
    this.render();
  }

  backspace(): void {
    const chars = this.currentChars();
    if (this.col > 0) {
      chars.splice(this.col - 1, 1);
      this.setCurrentChars(chars);
      this.col--;
    } else if (this.row > 0) {
      const prevLen = charLen(this.lines[this.row - 1]);
      this.lines[this.row - 1] = this.lines[this.row - 1] + this.lines[this.row];
      this.lines.splice(this.row, 1);
      this.row--;
      this.col = prevLen;
    }
    this.render();
  }

  deleteForward(): void {
    const chars = this.currentChars();
    if (this.col < chars.length) {
      chars.splice(this.col, 1);
      this.setCurrentChars(chars);
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] = this.lines[this.row] + this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
    }
    this.render();
  }

  killToStart(): void {
    const chars = this.currentChars();
    this.setCurrentChars(chars.slice(this.col));
    this.col = 0;
    this.render();
  }

  killToEnd(): void {
    const chars = this.currentChars();
    this.setCurrentChars(chars.slice(0, this.col));
    this.render();
  }

  killWordBefore(): void {
    const chars = this.currentChars();
    let i = this.col;
    while (i > 0 && /\s/.test(chars[i - 1])) i--;
    while (i > 0 && !/\s/.test(chars[i - 1])) i--;
    chars.splice(i, this.col - i);
    this.setCurrentChars(chars);
    this.col = i;
    this.render();
  }

  killWordAfter(): void {
    const chars = this.currentChars();
    const n = chars.length;
    let i = this.col;
    while (i < n && /\s/.test(chars[i])) i++;
    while (i < n && !/\s/.test(chars[i])) i++;
    chars.splice(this.col, i - this.col);
    this.setCurrentChars(chars);
    this.render();
  }

  /** Replace the UTF-16 range `[from, from + removeText.length)` on the
   *  current buffer line with `insertText`, placing the cursor right after. */
  replaceCompletionToken(from: number, removeText: string, insertText: string): void {
    const line = this.lines[this.row];
    const head = line.slice(0, from);
    const tail = line.slice(from + removeText.length);
    this.lines[this.row] = head + insertText + tail;
    this.col = charLen(head) + charLen(insertText);
  }

  /** Position of `partial` under the cursor (fallback: last in the line), or
   *  -1 when not found. */
  partialStart(line: string, partial: string): number {
    const chars = Array.from(line);
    const beforeCursor = chars.slice(0, this.col).join("");
    let from = beforeCursor.lastIndexOf(partial);
    if (from === -1) from = line.lastIndexOf(partial);
    return from;
  }
}
