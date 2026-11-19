/**
 * Tab-комплит и циклирование кандидатов. Вынесено из `line-editor.ts`
 * (правило 6); токен под курсором, порядок печати списка и сброс DSR-якоря —
 * те же.
 */
import { renderCompletionRows } from "./completion-view";
import type { LineBuffer } from "./line-editor-buffer";
import type { CompletionItem, EditorOutput } from "./line-editor-types";

/** То, что нужно комплиту от редактора (реализуется `LineEditor`). */
export interface CompletionHost {
  buf: LineBuffer;
  output: EditorOutput;
  completer?: (line: string, cursor?: number) => [CompletionItem[], string];
  columns(): number;
  invalidateAnchor(): void;
  render(): void;
}

/** Применяет кандидата `index`, заменяя вставленное ранее значение. */
export function applyCompletionCandidate(host: CompletionHost, index: number): void {
  const s = host.buf.completion;
  if (!s) return;
  const chosen = s.items[index].value;
  host.buf.replaceCompletionToken(s.from, s.inserted, chosen);
  s.index = index;
  s.inserted = chosen;
  host.render();
}

export function cycleCompletion(host: CompletionHost, delta: number): void {
  const s = host.buf.completion;
  if (!s) return;
  const n = s.items.length;
  if (n === 0) return;
  const next = (s.index + delta + n) % n;
  applyCompletionCandidate(host, next);
}

/** Esc в сессии комплита: возвращает исходный partial. */
export function cancelCompletion(host: CompletionHost): void {
  const s = host.buf.completion;
  if (!s) return;
  host.buf.replaceCompletionToken(s.from, s.inserted, s.original);
  host.buf.completion = null;
  host.render();
}

export function tabComplete(host: CompletionHost): void {
  if (!host.completer) return;
  const line = host.buf.lines[host.buf.row];
  // Дополняется токен ПОД КУРСОРОМ, а не последний в строке (§8.15).
  const [matches, partial] = host.completer(line, host.buf.col);
  if (matches.length === 0) {
    host.output.write("\x07");
    return;
  }
  if (matches.length === 1) {
    // Дополняем partial ПОД КУРСОРОМ, а не последнее вхождение в строке: при
    // курсоре в середине lastIndexOf() вставлял в конец строки.
    const from = host.buf.partialStart(line, partial);
    if (from === -1) {
      host.output.write("\x07");
      return;
    }
    host.buf.replaceCompletionToken(from, partial, matches[0].value);
    host.render();
    return;
  }
  const from = host.buf.partialStart(line, partial);
  if (from === -1) {
    host.output.write("\x07");
    return;
  }
  const width = host.columns();
  const rows = renderCompletionRows(matches, width - 1);
  host.output.write(`\r\n${rows.join("\r\n")}\r\n`);
  // Напечатанный список увёл курсор ниже старого кадра. Сбрасываем абсолютный
  // якорь, чтобы следующий рендер позиционировался ОТНОСИТЕЛЬНО текущего
  // курсора (под списком). Сохранение DSR-якоря возвращало кадр на старую
  // абсолютную строку, и его `\x1b[J` стирал список: на Linux/macOS кандидаты
  // мигали и исчезали.
  host.invalidateAnchor();

  // Старт сессии циклирования с первым кандидатом в буфере:
  // ↑/↓/Tab крутят напечатанный список на месте.
  host.buf.completion = {
    items: matches,
    index: 0,
    from,
    original: partial,
    inserted: matches[0].value,
  };
  host.buf.replaceCompletionToken(from, partial, matches[0].value);
  host.render();
}
