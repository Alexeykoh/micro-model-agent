/**
 * Навигация по буферу и история ввода редактора. Вынесено из `line-editor.ts`
 * (правило 6); правила движения, стеш истории и порядок рендера — те же.
 */
import { charLen } from "./line-math";
import type { CompletionSession, Stash } from "./line-editor-buffer";

/** Поля буфера, нужные навигации и истории (реализуется `LineBuffer`). */
export interface NavTarget {
  lines: string[];
  row: number;
  col: number;
  history: string[];
  historySize: number;
  historyIndex: number;
  stash: Stash | null;
  completion: CompletionSession | null;
  render: () => void;
}

export function moveLeft(b: NavTarget): void {
  if (b.col > 0) {
    b.col--;
  } else if (b.row > 0) {
    b.row--;
    b.col = charLen(b.lines[b.row]);
  }
  b.render();
}

export function moveRight(b: NavTarget): void {
  if (b.col < charLen(b.lines[b.row])) {
    b.col++;
  } else if (b.row < b.lines.length - 1) {
    b.row++;
    b.col = 0;
  }
  b.render();
}

/** Ставит курсор в визуально вычисленную позицию (↑/↓ из layout). */
export function applyMove(b: NavTarget, row: number, col: number): void {
  b.row = row;
  b.col = col;
  b.render();
}

export function moveHome(b: NavTarget): void {
  b.col = 0;
  b.render();
}

export function moveEnd(b: NavTarget): void {
  b.col = charLen(b.lines[b.row]);
  b.render();
}

export function moveToStart(b: NavTarget): void {
  b.row = 0;
  b.col = 0;
  b.render();
}

export function moveToEnd(b: NavTarget): void {
  b.row = b.lines.length - 1;
  b.col = charLen(b.lines[b.row]);
  b.render();
}

export function moveWordLeft(b: NavTarget): void {
  const chars = Array.from(b.lines[b.row]);
  let i = b.col;
  while (i > 0 && /\s/.test(chars[i - 1])) i--;
  while (i > 0 && !/\s/.test(chars[i - 1])) i--;
  b.col = i;
  b.render();
}

export function moveWordRight(b: NavTarget): void {
  const chars = Array.from(b.lines[b.row]);
  const n = chars.length;
  let i = b.col;
  while (i < n && !/\s/.test(chars[i])) i++;
  while (i < n && /\s/.test(chars[i])) i++;
  b.col = i;
  b.render();
}

export function historyPrev(b: NavTarget): void {
  if (b.history.length === 0) return;
  if (b.historyIndex === -1) {
    b.stash = {
      lines: b.lines.slice(),
      row: b.row,
      col: b.col,
    };
    b.historyIndex = 0;
  } else if (b.historyIndex < b.history.length - 1) {
    b.historyIndex++;
  } else {
    return;
  }
  applyHistoryEntry(b);
}

export function historyNext(b: NavTarget): void {
  if (b.historyIndex === -1) return;
  if (b.historyIndex > 0) {
    b.historyIndex--;
    applyHistoryEntry(b);
  } else if (b.stash) {
    b.lines = b.stash.lines.slice();
    b.row = b.stash.row;
    b.col = b.stash.col;
    b.historyIndex = -1;
    b.stash = null;
    b.render();
  }
}

function applyHistoryEntry(b: NavTarget): void {
  b.completion = null;
  const entry = b.history[b.history.length - 1 - b.historyIndex];
  b.lines = entry.split("\n");
  if (b.lines.length === 0) b.lines = [""];
  b.row = b.lines.length - 1;
  b.col = charLen(b.lines[b.row]);
  b.render();
}

/** Запоминает отправленную строку (непустую) и сбрасывает курсор истории. */
export function recordHistory(b: NavTarget, text: string): void {
  if (text.trim()) {
    b.history.push(text);
    if (b.history.length > b.historySize) {
      b.history = b.history.slice(-b.historySize);
    }
  }
  b.historyIndex = -1;
  b.stash = null;
}
