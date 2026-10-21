// Отчёт `lsp_check`: накопленные диагностики → текст для модели.
//
// Вынесено из `module.ts`: это чистое представление результата, а не логика
// модуля (правило 6 AGENTS).
import { t } from "../../i18n/index";
import { formatCheckDiagnostics } from "./check-tool";
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
