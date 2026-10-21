// Математика строк редактора: ANSI-стрип, перенос по ширине, буфер↔экран маппинг.
import stringWidth from "string-width";

/** Строка раскладки: какая строка буфера и с какого символа начинается. */
export interface LayoutRow {
  bufRow: number;
  charStart: number;
  text: string;
}

/** Визуальная строка после переноса. */
export interface WrappedRow {
  text: string;
  charStart: number;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** OSC/DCS/APC — не входят в CSI, но тоже управляют терминалом. */
const ANSI_OSC_RE = /\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)/g;

/** Срезает ANSI-последовательности. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_OSC_RE, "").replace(ANSI_RE, "");
}

/** Длина в символах (не в байтах/ячейках). */
export function charLen(s: string): number {
  return Array.from(s).length;
}

/** Перенос строки по ширине (по словам, CJK-корректно). */
export function wrapLine(line: string, width: number, firstRowWidth?: number): WrappedRow[] {
  const w = width > 0 ? width : 80;
  // Только ПЕРВАЯ визуальная строка делит экранную строку с чем-то ещё
  // (напр. с промптом); все продолжения — на полную ширину.
  let limit = firstRowWidth !== undefined && firstRowWidth > 0 ? firstRowWidth : w;
  const chars = Array.from(line);
  const rows: WrappedRow[] = [];
  let start = 0;
  let cells = 0;
  let lastSpaceIdx = -1;
  let lastSpaceCells = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n") {
      rows.push({ text: chars.slice(start, i).join(""), charStart: start });
      start = i + 1;
      cells = 0;
      lastSpaceIdx = -1;
      lastSpaceCells = 0;
      continue;
    }
    const cw = stringWidth(ch);
    if (ch === " ") {
      lastSpaceIdx = i;
      lastSpaceCells = cells;
    }
    if (cells + cw > limit && cells > 0) {
      if (lastSpaceIdx > start) {
        rows.push({ text: chars.slice(start, lastSpaceIdx).join(""), charStart: start });
        start = lastSpaceIdx + 1;
        cells = Math.max(0, cells - lastSpaceCells - 1);
      } else {
        rows.push({ text: chars.slice(start, i).join(""), charStart: start });
        start = i;
        cells = cw;
      }
      lastSpaceIdx = -1;
      lastSpaceCells = 0;
      limit = w;
    } else {
      cells += cw;
    }
  }
  rows.push({ text: chars.slice(start).join(""), charStart: start });
  return rows;
}

/** Раскладка всех строк буфера в визуальные ряды. */
export function buildLayout(
  lines: string[],
  width: number,
  firstRowWidth?: number,
): LayoutRow[] {
  const rows: LayoutRow[] = [];
  for (let b = 0; b < lines.length; b++) {
    for (const r of wrapLine(lines[b], width, b === 0 ? firstRowWidth : undefined)) {
      rows.push({ bufRow: b, charStart: r.charStart, text: r.text });
    }
  }
  return rows;
}

/** Индекс визуального ряда по позиции буфера. */
export function layoutIndexFor(rows: LayoutRow[], bufRow: number, col: number): number {
  let idx = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].bufRow === bufRow && rows[i].charStart <= col) idx = i;
  }
  return idx;
}

/** Визуальная колонка по смещению в буфере. */
export function visualColAt(rows: LayoutRow[], idx: number, col: number): number {
  const r = rows[idx];
  const upTo = col - r.charStart;
  return stringWidth(Array.from(r.text).slice(0, upTo).join(""));
}

/** Смещение в буфере по визуальной колонке. */
export function charOffsetFor(rows: LayoutRow[], idx: number, visualCol: number): number {
  const r = rows[idx];
  const chars = Array.from(r.text);
  let cells = 0;
  for (let i = 0; i < chars.length; i++) {
    const cw = stringWidth(chars[i]);
    if (cells + cw > visualCol) return r.charStart + i;
    cells += cw;
  }
  return r.charStart + chars.length;
}
