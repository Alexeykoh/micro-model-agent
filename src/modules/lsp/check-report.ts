// Отчёт `lsp_check`: накопленные диагностики → текст для модели.
//
// Вынесено из `module.ts`: это чистое представление результата, а не логика
// модуля (правило 6 AGENTS).
import { t } from "../../i18n/index";
import { formatCheckDiagnostics, severityLabel } from "./check-tool";
import { toForwardSlash } from "../../tools/path-utils";
import { relative } from "path";
import type { LspDiagnostic } from "./types";
import type { ToolResult } from "../../tools/types";

/** Накопитель результатов `lsp_check` по нескольким файлам. */
export interface CheckAccumulator {
  baseDir: string;
  errors: Array<{ file: string; diag: LspDiagnostic }>;
  warnings: Array<{ file: string; diag: LspDiagnostic }>;
  notes: string[];
  checkedFiles: string[];
  checked: number;
  inconclusive: number;
  suppressed: number;
  /** Файлы, пропущенные из-за холодного старта сервера (ждать 30 с бессмысленно). */
  cold: number;
  /** Файлы, для которых сервер LSP не настроен (не «сервер молчит»). */
  unsupported: string[];
}

/**
 * Текст отчёта по аккумулятору.
 *
 * Если ничего не проверено (`checked === 0`), отчёт НЕ «чистый»: это
 * «неокончательно» — сервер молчал или файлы не нашлись, и модель не должна
 * объявлять отсутствие ошибок (аудит §8.6).
 */
export function renderCheckReport(acc: CheckAccumulator): ToolResult {
  const lines: string[] = [];
  if (acc.checked > 0) {
    lines.push(t("lsp.checked_files", { count: String(acc.checked) }));
    lines.push(...acc.checkedFiles.map((f) => `  ${f}`));
  }
  if (acc.errors.length > 0) {
    lines.push(`[LSP errors] (${acc.errors.length}):`);
    lines.push(formatCheckDiagnostics(acc.errors, acc.baseDir));
  }
  if (acc.warnings.length > 0) {
    lines.push(`[LSP warnings] (${acc.warnings.length}):`);
    lines.push(formatCheckDiagnostics(acc.warnings, acc.baseDir));
  }
  if (acc.checked > 0 && acc.errors.length === 0 && acc.warnings.length === 0) {
    lines.push(t("lsp.check_clean", { count: String(acc.checked) }));
  }
  if (acc.suppressed > 0) {
    lines.push(
      t("lsp.check_suppressed", { count: String(acc.suppressed) }),
    );
  }
  // Сервер молчал хотя бы на одном файле: это НЕ «чисто», и модель не должна
  // объявлять отсутствие ошибок.
  if (acc.inconclusive > 0) {
    lines.push(
      t("lsp.check_silent", { silent: String(acc.inconclusive), total: String(acc.checked) }),
    );
  }
  // Холодный старт: файлы не проверены вовсе — это не «чисто» и не «молчание».
  if (acc.cold > 0) {
    lines.push(t("lsp.check_cold", { count: String(acc.cold) }));
  }
  // Формат без настроенного сервера: это НЕ «сервер не ответил». Раньше такие
  // файлы молча пропускались и отчёт писал «проверка неокончательна», хотя
  // проверять их нечем в принципе (md/yaml/txt и т.п.).
  if (acc.unsupported.length > 0) {
    const list = acc.unsupported.map((f) => toForwardSlash(relative(acc.baseDir, f))).join(", ");
    lines.push(t("lsp.check_unsupported", { path: list }));
  }
  lines.push(...acc.notes);
  if (acc.checked === 0) {
    return {
      success: false,
      output: lines.length > 0 ? lines.join("\n") : t("lsp.check_inconclusive"),
    };
  }
  if (lines.length === 0) {
    return { success: true, output: t("lsp.check_clean", { count: String(acc.checked) }) };
  }
  return { success: acc.errors.length === 0, output: lines.join("\n") };
}

/** Диагностики одного файла (до 5 строк) для отчёта lsp_check. */
export function formatOneFileDiagnostics(diagnostics: LspDiagnostic[], filePath: string): string {
  const filename = toForwardSlash(filePath).split("/").pop() ?? filePath;
  return diagnostics
    .slice(0, 5)
    .map((d) => {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const sev = severityLabel(d);
      return `  ${filename}(${line},${col}): ${sev}: ${d.message}`;
    })
    .join("\n");
}