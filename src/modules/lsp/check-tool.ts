// lsp_check: сбор файлов для проверки и форматирование диагностик.
import { readdir, stat } from "fs/promises";
import { resolve, relative } from "path";
import type { LspDiagnostic, LspConfig } from "./types";
import { getServerForFile } from "./config";
import { toForwardSlash } from "../../tools/path-utils";

/** Режим каталога lsp_check: глубина обхода и кап файлов на вызов. */
export const MAX_LSP_CHECK_FILES = 15;
/**
 * Кап обхода для определения применимости серверов в `/lsp doctor`: файлы не
 * проверяются, нужен только факт наличия языка — обход шире, чем у `lsp_check`.
 */
export const LSP_DIAGNOSE_SCAN_LIMIT = 100;
const MAX_LSP_WALK_DEPTH = 4;
const SKIP_DIRS = new Set(["node_modules", ".git", ".mma", "dist"]);

/** Подписи severity диагностик. */
export const severityLabels: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/**
 * Подпись severity с дефолтом `error` (спека: отсутствующий severity = ошибка).
 * Отдельная функция, а не индексация словарём: `severity` теперь опционален.
 */
export function severityLabel(diagnostic: LspDiagnostic): string {
  const severity = diagnostic.severity;
  if (severity === undefined || severity === 0) return "error";
  return severityLabels[severity] ?? "unknown";
}

/**
 * Резолв цели: файл (точечная проверка) или ограниченный список исходников
 * (проверка каталога, кап MAX_LSP_CHECK_FILES). Собираются только файлы с
 * настроенным LSP-сервером — неподдерживаемые расширения молча не проверяются.
 */
export async function collectCheckFiles(
  resolved: string,
  config: LspConfig,
  limit: number = MAX_LSP_CHECK_FILES,
): Promise<string[]> {
  const info = await stat(resolved).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [resolved];
  const out: string[] = [];
  await walkDir(resolved, 0, out, config, limit);
  return out;
}

async function walkDir(
  dir: string,
  depth: number,
  out: string[],
  config: LspConfig,
  limit: number,
): Promise<void> {
  if (depth > MAX_LSP_WALK_DEPTH || out.length >= limit) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkDir(resolve(dir, entry.name), depth + 1, out, config, limit);
    } else if (entry.isFile() && getServerForFile(resolve(dir, entry.name), config)) {
      out.push(resolve(dir, entry.name));
    }
  }
}

/** Форматировать диагностики списком `файл(стр,кол): severity: текст` (первые 40). */
export function formatCheckDiagnostics(
  items: Array<{ file: string; diag: LspDiagnostic }>,
  baseDir: string,
): string {
  return items
    .slice(0, 40)
    .map(({ file, diag }) => {
      const rel = toForwardSlash(relative(baseDir, file));
      const line = diag.range.start.line + 1;
      const col = diag.range.start.character + 1;
      const sev = severityLabel(diag);
      return `  ${rel}(${line},${col}): ${sev}: ${diag.message}`;
    })
    .join("\n");
}
