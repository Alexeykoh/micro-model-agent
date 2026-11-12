/**
 * Статистика и текст карты проекта (правило ≤300 строк).
 *
 * Вынесено из `module.ts`: сборка `ProjectMapInfo` для сайдбара и текст
 * отчёта «карта проекта» для системного промпта. Кэш — у вызывающего модуля.
 */
import type { IndexedFile, IndexResult } from "./walker";
import type { ProjectMapInfo } from "../../core/host";
import { buildMapInfo, emptyMapInfo } from "./format";
import { formatMapReport } from "./map-report";
import { buildProjectProfileLine } from "./project-profile";
import { computeRanks } from "./format";
import { estimateTokens } from "../../llm/token-counter";

/** Состояние модуля, нужное карте (без кэша/вотчера). */
export interface MapViewInput {
  index: IndexResult | null;
  indexing: boolean;
  builtAt: number | null;
  watcherActive: boolean;
  baseDir: string;
  maxFiles: number;
  mapTokenBudget: number;
  summarize: (result: IndexResult) => string;
}

/** Статистика карты для сайдбара (индекса нет — счётчики нулевые). */
export function mapInfoOf(input: MapViewInput): ProjectMapInfo {
  if (!input.index) {
    return emptyMapInfo({
      indexing: input.indexing,
      builtAt: input.builtAt,
      watcher: input.watcherActive,
    });
  }
  const tokens = estimateTokens(formatMapOf(input, input.index));
  return buildMapInfo(input.index.files, {
    tokens,
    builtAt: input.builtAt,
    watcher: input.watcherActive,
  });
}

/** Текст отчёта «карта проекта» (формат — в `map-report.ts`). */
export function formatMapOf(input: MapViewInput, result: IndexResult): string {
  return formatMapReport(result, {
    baseDir: input.baseDir,
    maxFiles: input.maxFiles,
    mapTokenBudget: input.mapTokenBudget,
    ranks: computeRanks(result),
    summary: input.summarize(result),
    stackLine: buildProjectProfileLine(input.baseDir),
  });
}

/** Файлы индекса (только чтение) для внешних потребителей. */
export function filesOf(index: IndexResult | null): IndexedFile[] {
  return index?.files ?? [];
}
