// Форматирование результатов поиска по карте проекта и статистики карты.
//
// Вынесено из `module.ts`: это чистое представление индекса, а не состояние
// модуля (правило 6 AGENTS). Кэш, вотчер и сборка индекса сюда не проникают —
// все входы приходят аргументами.
import { toForwardSlash } from "../../tools/path-utils";
import { estimateTokens } from "../../llm/token-counter";
import { t } from "../../i18n/index";
import { buildFileGraph } from "./graph";
import type { ProjectMapInfo } from "../../core/host";
import type { IndexedFile, IndexResult } from "./walker";
import type { SymbolHit } from "./rank";
import type { SymbolLocationHit } from "./provider";

export { estimateTokens };

/** Макс. строк в результатах find/symbol (хвост — счётчиком). */
const FIND_LIMIT = 50;

/** Макс. символов в outline одного файла. */
const OUTLINE_LIMIT = 80;

/** Суффикс `— <сигнатура>` к строке символа (пусто, если сигнатуры нет). */
function signatureSuffix(signature?: string): string {
  return signature ? ` — ${signature}` : "";
}

/** Хвост «... ещё N» для усечённого списка (пусто, если всё влезло). */
function truncationNote(total: number, shown: number): string {
  return total > shown ? `\n${t("indexer.find_more", { count: total - shown })}` : "";
}

/** Человеко/модельно-читаемый результат `find` (общий для тула и `mma map`). */
export function formatFindResults(matches: IndexedFile[], query: string): string {
  if (matches.length === 0) return t("indexer.no_matches", { query });
  const shown = matches.slice(0, FIND_LIMIT);
  const lines = shown
    .map((f) => {
      const path = toForwardSlash(f.path);
      const exports = f.exports.length > 0 ? `: ${f.exports.join(", ")}` : "";
      return `- ${path}${exports}`;
    })
    .join("\n");
  return t("indexer.find_results", {
    count: matches.length,
    results: lines + truncationNote(matches.length, shown.length),
  });
}

/** Ранжированный список мест определения символа (`path:line name (kind)`). */
export function formatSymbolResults(hits: SymbolHit[], query: string): string {
  if (hits.length === 0) return t("indexer.no_matches", { query });
  const shown = hits.slice(0, FIND_LIMIT);
  const lines = shown
    .map(
      (h) =>
        `- ${toForwardSlash(h.file.path)}:${h.line} ${h.name} (${h.kind})${signatureSuffix(h.signature)}`,
    )
    .join("\n");
  return t("indexer.symbol_results", {
    count: hits.length,
    results: lines + truncationNote(hits.length, shown.length),
  });
}

/** Оглавление файла: символы с номерами строк (без чтения тела). */
export function formatOutlineResult(file: IndexedFile | null, query: string): string {
  if (!file) return t("indexer.no_matches", { query });
  const path = toForwardSlash(file.path);
  if (file.symbols.length === 0) {
    return `${path}\n${t("indexer.outline_empty")}`;
  }
  const shown = file.symbols.slice(0, OUTLINE_LIMIT);
  const lines = shown
    .map((s) => `  ${s.line}: ${s.name} (${s.kind})${signatureSuffix(s.signature)}`)
    .join("\n");
  const more = truncationNote(file.symbols.length, shown.length);
  return `${path}\n${lines}${more}`;
}

/** Формат локаций внешнего провайдера (`path:line name (kind)`). */
export function formatLspSymbols(hits: SymbolLocationHit[]): string {
  const shown = hits.slice(0, FIND_LIMIT);
  const lines = shown
    .map((h) => `- ${toForwardSlash(h.path)}:${h.line} ${h.name} (${h.kind})`)
    .join("\n");
  return t("indexer.symbol_results", {
    count: hits.length,
    results: lines + truncationNote(hits.length, shown.length),
  });
}

/** PageRank-ранги файлов (чистый расчёт; кэширует вызывающий). */
export function computeRanks(result: IndexResult): Map<string, number> {
  return buildFileGraph(result.files).ranks;
}

/** Полная статистика карты: счётчики, разбивка по языкам, время сборки. */
export function buildMapInfo(
  files: IndexedFile[],
  meta: { tokens: number; builtAt: number | null; watcher: boolean },
): ProjectMapInfo {
  const symbols = files.reduce((n, f) => n + f.exports.length, 0);
  const langMap = new Map<string, { files: number; symbols: number }>();
  for (const f of files) {
    const lang = f.language;
    const cur = langMap.get(lang) ?? { files: 0, symbols: 0 };
    cur.files += 1;
    cur.symbols += f.exports.length;
    langMap.set(lang, cur);
  }
  const languages = [...langMap.entries()]
    .map(([language, v]) => ({ language, ...v }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language))
    .slice(0, 8);
  return {
    indexed: true,
    files: files.length,
    symbols,
    tokens: meta.tokens,
    updatedAt: meta.builtAt,
    languages,
    watcher: meta.watcher,
  };
}

/** Статистика до конца первого обхода: индекса ещё нет, счётчики нулевые. */
export function emptyMapInfo(meta: {
  indexing: boolean;
  builtAt: number | null;
  watcher: boolean;
}): ProjectMapInfo {
  return {
    indexed: false,
    indexing: meta.indexing,
    files: 0,
    symbols: 0,
    tokens: 0,
    updatedAt: meta.builtAt,
    languages: [],
    watcher: meta.watcher,
  };
}
