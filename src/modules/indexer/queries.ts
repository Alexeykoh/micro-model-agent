/**
 * Поисковые представления индексатора (правило ≤300 строк).
 *
 * Вынесено из `module.ts`: `find`/`symbols`/`outline` — чистые обёртки над
 * ранжированием и форматированием, не зависят от кэша и вотчера модуля.
 */
import { t } from "../../i18n/index";
import type { IndexedFile, IndexResult } from "./walker";
import { rankFiles, rankSymbols, matchOutline } from "./rank";
import { formatFindResults, formatOutlineResult, formatSymbolResults } from "./format";

/** Ранжированный поиск файлов по запросу. */
export function findFiles(index: IndexResult | null, query: string): IndexedFile[] {
  if (!index) return [];
  return rankFiles(index.files, query).map((r) => r.file);
}

/** Человеко/модельно-читаемый результат `find` (общий для тула и `mma map`). */
export function findText(index: IndexResult | null, query: string): string {
  return formatFindResults(findFiles(index, query), query);
}

/** Ранжированный список мест определения символа (`path:line name (kind)`). */
export function symbolsText(index: IndexResult | null, query: string): string {
  if (!index) return t("indexer.not_indexed");
  return formatSymbolResults(rankSymbols(index.files, query), query);
}

/** Оглавление файла: символы с номерами строк (без чтения тела). */
export function outlineText(index: IndexResult | null, query: string): string {
  if (!index) return t("indexer.not_indexed");
  return formatOutlineResult(matchOutline(index.files, query), query);
}

/** Есть ли среди файлов определения символа (для приоритета LSP-провайдера). */
export function hasIndexedSymbols(index: IndexResult | null, query: string): boolean {
  return index ? rankSymbols(index.files, query).length > 0 : false;
}
