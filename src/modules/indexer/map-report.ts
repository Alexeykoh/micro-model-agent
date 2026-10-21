// Отчёт «карта проекта»: сводка, каталоги, дубли имён, список файлов.
//
// Вынесено из `module.ts`: это чистое представление индекса, а не состояние
// модуля (правило 6 AGENTS).
import { dirname } from "path";
import { t } from "../../i18n/index";
import { toForwardSlash } from "../../tools/path-utils";
import { estimateTokens } from "../../llm/token-counter";
import { selectByRank } from "./rank";
import { selectMapFiles } from "./map-select";
import type { IndexResult } from "./walker";

/** Опции отчёта. */
export interface MapReportOptions {
  baseDir: string;
  maxFiles: number;
  mapTokenBudget: number;
  /** PageRank-ранги файлов (считает вызывающий — граф кэшируется). */
  ranks: Map<string, number>;
  /** Сводка индекса (считает вызывающий: у индексера свой summarizer). */
  summary: string;
  /** Строка профиля стека (может быть пустой). */
  stackLine: string | null;
}

/**
 * Файлы с общим basename при разных расширениях в одном каталоге
 * (напр. `ProductCard.js` + `ProductCard.tsx`). Чисто структурный факт дерева —
 * протухший транспилированный близнец может затенять реальный исходник на
 * сборке. Подсветить его — не классификация задач.
 */
export function findDuplicateBasenames(result: IndexResult): string[] {
  const byDir: Record<string, Map<string, string[]>> = {};
  for (const f of result.files) {
    const path = toForwardSlash(f.path);
    const idx = path.lastIndexOf("/");
    const dir = idx >= 0 ? path.slice(0, idx) : "";
    const name = path.slice(idx + 1);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const base = name.slice(0, dot);
    const ext = name.slice(dot + 1);
    if (!byDir[dir]) byDir[dir] = new Map();
    const list = byDir[dir].get(base) ?? [];
    list.push(ext);
    byDir[dir].set(base, list);
  }
  const dups: string[] = [];
  for (const dir of Object.keys(byDir).sort()) {
    for (const [base, exts] of byDir[dir]) {
      if (exts.length < 2) continue;
      const uniqueExts = [...new Set(exts)].sort();
      const dirPrefix = dir ? `${dir}/` : "";
      dups.push(`${dirPrefix}${base}.{${uniqueExts.join(",")}}`);
    }
  }
  return dups;
}

/** Счётчик файлов по каталогу. */
export function getDirectoryCounts(result: IndexResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of result.files) {
    const normalized = toForwardSlash(f.path);
    const dir = dirname(normalized);
    const key = dir === "." ? "(root)" : dir;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** Текст отчёта «карта проекта». */
export function formatMapReport(result: IndexResult, opts: MapReportOptions): string {
  const dirCounts = getDirectoryCounts(result);
  const topDirs =
    Object.entries(dirCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([dir, count]) => `${dir} (${count})`)
      .join(", ") || "-";

  const ranks = opts.ranks;
  const listed =
    ranks.size > 0
      ? selectByRank(result.files, ranks, opts.mapTokenBudget, (s) => estimateTokens(s))
      : selectMapFiles(result.files, opts.mapTokenBudget);
  const fileLines = listed.map((f) => {
    const path = toForwardSlash(f.path);
    const exports = f.exports.length > 0 ? `: ${f.exports.join(", ")}` : "";
    return `- ${path}${exports}`;
  });

  const more =
    result.files.length > listed.length
      ? `\n${t("indexer.and_more", { count: result.files.length - listed.length })}`
      : "";

  const duplicates = findDuplicateBasenames(result);
  const truncated = result.files.length >= opts.maxFiles;

  return [
    `${t("indexer.map_header")} (${opts.baseDir})`,
    opts.summary,
    ...(truncated ? [t("indexer.truncated", { max: String(opts.maxFiles) })] : []),
    ...(opts.stackLine ? [opts.stackLine] : []),
    `${t("indexer.top_directories")}: ${topDirs}`,
    ...(duplicates.length > 0 ? [t("indexer.duplicates", { names: duplicates.join(", ") })] : []),
    `${t("indexer.files")}:${fileLines.length > 0 ? "" : ` ${t("indexer.empty")}`}`,
    ...fileLines,
    more,
  ].join("\n");
}
