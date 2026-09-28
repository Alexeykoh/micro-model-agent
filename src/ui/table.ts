// Таблицы чата: парсинг markdown-строк, выравнивание колонок (без рамок, см. STYLE.md).
import stringWidth from "string-width";
import { pc } from "./colors";

/** Выравнивание ячейки. */
export type CellAlign = "left" | "center" | "right";

/** Опции таблицы: выравнивания, капы ширины и числа колонок. */
export interface TableOptions {
  /** Индекс колонки → выравнивание. Дефолт: данные влево, шапка по центру. */
  align?: Record<number, CellAlign>;
  /** Жёсткий кап общей ширины (колонки ужимаются). */
  maxWidth?: number;
  /** Колонки сверх этого числа отбрасываются. */
  maxColumns?: number;
}

const ELLIPSIS = "…";

function pad(text: string, width: number, align: CellAlign): string {
  const visible = stringWidth(text);
  const gap = Math.max(0, width - visible);
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + text + " ".repeat(gap - left);
  }
  return text + " ".repeat(gap);
}

function truncate(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let acc = "";
  for (const ch of text) {
    if (stringWidth(acc + ch) > width - 1) break;
    acc += ch;
  }
  return acc + ELLIPSIS;
}

/** Режет строку `| a | b |` на ячейки. */
export function splitRow(line: string): string[] {
  const trimmed = line.trim();
  let body = trimmed;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split("|").map((c) => c.trim());
}

/** Детект строки-разделителя вида `|---|---|` / `:---:` / `---:`. */
export function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  const cells = splitRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/** Выравнивания из строки-разделителя, по индексу колонки. */
export function parseAlignments(separator: string): Record<number, CellAlign> {
  const out: Record<number, CellAlign> = {};
  splitRow(separator).forEach((cell, i) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) out[i] = "center";
    else if (right) out[i] = "right";
  });
  return out;
}

/**
 * Рендерит markdown-блок таблицы в выровненные строки без рамок.
 * `tableLines` включает строку шапки и опц. строку-разделитель.
 */
export function formatTable(tableLines: string[], opts: TableOptions = {}): string[] {
  const align: Record<number, CellAlign> = opts.align ?? {};
  let dataStart = 1;
  if (tableLines.length > 1 && isSeparatorRow(tableLines[1])) {
    dataStart = 2;
    Object.assign(align, parseAlignments(tableLines[1]));
  }
  const rows = tableLines.map(splitRow);
  const headerRow = rows[0] ?? [];
  const dataRows = rows.slice(dataStart);

  let columnCount = Math.max(headerRow.length, ...dataRows.map((r) => r.length));
  if (opts.maxColumns && columnCount > opts.maxColumns) {
    columnCount = opts.maxColumns;
  }

  const widths: number[] = [];
  for (let c = 0; c < columnCount; c++) {
    let w = 3;
    for (const row of rows) {
      const cell = row[c];
      if (cell !== undefined) w = Math.max(w, stringWidth(cell));
    }
    widths.push(w);
  }

  const maxWidth = opts.maxWidth ?? getTerminalWidth();
  const GAP = "  ";
  const contentWidth = widths.reduce((a, b) => a + b, 0);
  const totalWidth = contentWidth + GAP.length * Math.max(0, columnCount - 1);
  if (totalWidth > maxWidth) {
    const over = totalWidth - maxWidth;
    let remaining = over;
    let i = widths.length - 1;
    while (remaining > 0 && i >= 0) {
      if (widths[i] > 3) {
        const cut = Math.min(widths[i] - 3, remaining);
        widths[i] -= cut;
        remaining -= cut;
      }
      i--;
    }
  }

  const renderRow = (row: string[], isHeader: boolean): string => {
    const cells: string[] = [];
    for (let c = 0; c < columnCount; c++) {
      const raw = row[c] ?? "";
      const cell = truncate(raw, widths[c]);
      const a = isHeader && align[c] === undefined ? "left" : (align[c] ?? "left");
      cells.push(pad(cell, widths[c], a));
    }
    const content = cells.join(GAP);
    return isHeader ? pc.bold(content) : content;
  };

  // Без box-рамок: жирная шапка, dim-линейка, выровненные колонки.
  const out: string[] = [];
  out.push(renderRow(headerRow, true));
  const ruleWidth = widths.reduce((a, b) => a + b, 0) + GAP.length * Math.max(0, columnCount - 1);
  out.push(pc.dim("─".repeat(Math.max(3, Math.min(ruleWidth, maxWidth - 1)))));
  for (const row of dataRows) {
    out.push(renderRow(row, false));
  }
  return out;
}

/** Ширина терминала; вне TTY — 80. */
export function getTerminalWidth(): number {
  if (process.stdout.isTTY && process.stdout.columns) {
    return process.stdout.columns;
  }
  return 80;
}

/** Строит pipe-строки из структурных данных и рендерит таблицей. */
export function renderTable(
  headers: string[],
  rows: string[][],
  opts: TableOptions = {},
): string[] {
  const lines: string[] = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`|${headers.map(() => "---").join("|")}|`);
  for (const row of rows) {
    lines.push(`| ${row.join(" | ")} |`);
  }
  return formatTable(lines, opts);
}
