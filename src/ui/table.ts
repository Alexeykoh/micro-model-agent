// Таблицы чата: парсинг markdown-строк, выравнивание колонок (без рамок, см. STYLE.md).
import stringWidth from "string-width";
import { pc } from "./colors";
import { t } from "../i18n/index";

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

/** Минимальная ширина колонки (иначе в неё не влезет даже заголовок). */
const MIN_COL_WIDTH = 3;

/** Сколько колонок показываем по умолчанию (как в вебе). */
export const DEFAULT_MAX_COLUMNS = 8;

/**
 * Рендерит markdown-блок таблицы в выровненные строки без рамок.
 * `tableLines` включает строку шапки и опц. строку-разделитель.
 *
 * Таблица ВСЕГДА влезает в ширину терминала: колонки ужимаются справа налево,
 * а если не помогает — последняя колонка переносится по словам. Колонки сверх
 * `maxColumns` отбрасываются с пометкой `… ещё N` (аудит §8.14).
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
  const maxColumns = opts.maxColumns ?? DEFAULT_MAX_COLUMNS;
  let dropped = 0;
  if (maxColumns > 0 && columnCount > maxColumns) {
    dropped = columnCount - maxColumns;
    columnCount = maxColumns;
  }

  const widths: number[] = [];
  for (let c = 0; c < columnCount; c++) {
    let w = MIN_COL_WIDTH;
    for (const row of rows) {
      const cell = row[c];
      if (cell !== undefined) w = Math.max(w, stringWidth(cell));
    }
    widths.push(w);
  }

  const maxWidth = opts.maxWidth ?? getTerminalWidth();
  const GAP = "  ";
  const gapWidth = GAP.length * Math.max(0, columnCount - 1);
  let overflow = widths.reduce((a, b) => a + b, 0) + gapWidth - maxWidth;
  // Ужимаем справа налево, но не ниже собственной шапки: «Об…»/«Со…» теряют
  // информацию, пока рядом есть колонка с длинным содержимым (имя сессии).
  const headerFloor = (c: number): number =>
    Math.max(MIN_COL_WIDTH, stringWidth(headerRow[c] ?? ""));
  for (let i = widths.length - 1; i >= 0 && overflow > 0; i--) {
    if (widths[i] <= headerFloor(i)) continue;
    const cut = Math.min(widths[i] - headerFloor(i), overflow);
    widths[i] -= cut;
    overflow -= cut;
  }
  // Не влезло и с целыми шапками — жертвуем шапками, а не экраном.
  for (let i = widths.length - 1; i >= 0 && overflow > 0; i--) {
    if (widths[i] <= MIN_COL_WIDTH) continue;
    const cut = Math.min(widths[i] - MIN_COL_WIDTH, overflow);
    widths[i] -= cut;
    overflow -= cut;
  }
  // Даже минимальные колонки не влезают: последняя колонка переносится по
  // словам — вылет за экран хуже переноса.
  const wrapLast = overflow > 0 && columnCount > 0;
  const lastWidth = widths[columnCount - 1] ?? MIN_COL_WIDTH;

  const renderCells = (row: string[], isHeader: boolean): string[] => {
    const cells: string[] = [];
    for (let c = 0; c < columnCount; c++) {
      const raw = row[c] ?? "";
      const cell = truncate(raw, widths[c]);
      const a = align[c] ?? (isHeader ? "center" : "left");
      cells.push(pad(cell, widths[c], a));
    }
    return cells;
  };

  // Строка может развернуться в несколько физических строк (перенос последней
  // колонки по словам).
  const renderRow = (row: string[], isHeader: boolean): string[] => {
    const cells = renderCells(row, isHeader);
    const join = (line: string[]): string =>
      (isHeader ? pc.bold(line.join(GAP)) : line.join(GAP)).replace(/\s+$/, "");
    if (!wrapLast) return [join(cells)];
    const lastRaw = row[columnCount - 1] ?? "";
    const chunks = wrapByWords(lastRaw, lastWidth);
    if (chunks.length <= 1) return [join(cells)];
    const out: string[] = [];
    chunks.forEach((chunk, i) => {
      const line = [...cells];
      line[columnCount - 1] = pad(
        truncate(chunk, lastWidth),
        lastWidth,
        align[columnCount - 1] ?? (isHeader ? "center" : "left"),
      );
      if (i > 0) {
        // Продолжение: колонки слева пустые, чтобы чтение оставалось ровным.
        for (let c = 0; c < columnCount - 1; c++) line[c] = " ".repeat(widths[c]);
      }
      out.push(join(line));
    });
    return out;
  };

  // Без box-рамок: жирная шапка, dim-линейка, выровненные колонки.
  const out: string[] = [];
  out.push(...renderRow(headerRow, true));
  const ruleWidth = widths.reduce((a, b) => a + b, 0) + gapWidth;
  out.push(pc.dim("─".repeat(Math.max(3, Math.min(ruleWidth, maxWidth - 1)))));
  for (const row of dataRows) {
    out.push(...renderRow(row, false));
  }
  if (dropped > 0) {
    out.push(pc.dim(t("ui.table_more_columns", { count: String(dropped) })));
  }
  return out;
}

/** Перенос текста по словам под ширину (слова не режутся, если не влезают). */
function wrapByWords(text: string, width: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && stringWidth(candidate) > width) {
      out.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [""];
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
