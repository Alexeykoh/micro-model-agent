import stringWidth from "string-width";

export interface LayoutRow {
  bufRow: number;
  charStart: number;
  text: string;
}

export interface WrappedRow {
  text: string;
  charStart: number;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function charLen(s: string): number {
  return Array.from(s).length;
}

export function wrapLine(line: string, width: number): WrappedRow[] {
  const w = width > 0 ? width : 80;
  const chars = Array.from(line);
  const rows: WrappedRow[] = [];
  let start = 0;
  let cells = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n") {
      rows.push({ text: chars.slice(start, i).join(""), charStart: start });
      start = i + 1;
      cells = 0;
      continue;
    }
    const cw = stringWidth(ch);
    if (cells + cw > w && cells > 0) {
      rows.push({ text: chars.slice(start, i).join(""), charStart: start });
      start = i;
      cells = cw;
    } else {
      cells += cw;
    }
  }
  rows.push({ text: chars.slice(start).join(""), charStart: start });
  return rows;
}

export function buildLayout(lines: string[], width: number): LayoutRow[] {
  const rows: LayoutRow[] = [];
  for (let b = 0; b < lines.length; b++) {
    for (const r of wrapLine(lines[b], width)) {
      rows.push({ bufRow: b, charStart: r.charStart, text: r.text });
    }
  }
  return rows;
}

export function layoutIndexFor(rows: LayoutRow[], bufRow: number, col: number): number {
  let idx = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].bufRow === bufRow && rows[i].charStart <= col) idx = i;
  }
  return idx;
}

export function visualColAt(rows: LayoutRow[], idx: number, col: number): number {
  const r = rows[idx];
  const upTo = col - r.charStart;
  return stringWidth(Array.from(r.text).slice(0, upTo).join(""));
}

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
