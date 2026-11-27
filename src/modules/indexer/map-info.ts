/**
 * Статистика и текст карты проекта (правило ≤300 строк).
 *
 * Вынесено из `module.ts`: сборка `ProjectMapInfo` для сайдбара и текст
 * отчёта «карта проекта» для системного промпта. Кэш — у вызывающего модуля.
 */
import type { IndexedFile, IndexResult } from "./walker";
import type { ProjectMapInfo } from "../../core/host";
import type { PromptBlock } from "../../core/types";
import { buildMapInfo, emptyMapInfo } from "./format";
import { formatMapReport } from "./map-report";
import { buildProjectProfileLine } from "./project-profile";
import { computeRanks } from "./format";
import { focusRanks, FOCUS_RANK_NONE } from "./rank";
import { estimateTokens } from "../../llm/token-counter";

/** Бюджет карты на больших окнах (L2): ~3% окна 200K вместо полного списка. */
export const LARGE_MAP_TOKEN_BUDGET = 6000;

/**
 * Эффективный бюджет карты (L2): явный конфиг — как есть; дефолт на большом
 * окне поднимается до `LARGE_MAP_TOKEN_BUDGET`. `explicit` — ключ реально
 * присутствовал в конфиге/env; значение, равное дефолту, — пользовательское.
 */
export function effectiveMapTokenBudget(
  configured: number | undefined,
  defaultBudget: number,
  contextWindow: number,
  largeWindowThreshold: number,
  explicit = false,
): number {
  if (explicit) return configured ?? defaultBudget;
  if (configured !== undefined && configured !== defaultBudget) return configured;
  return contextWindow >= largeWindowThreshold ? LARGE_MAP_TOKEN_BUDGET : defaultBudget;
}

/** Короткий системный блок: карта запрашивается тулом, а не грузится заранее. */
export function stubMapPromptBlock(): PromptBlock {
  const content = [
    "Workspace map is not preloaded. Call `project_map` with action `map`",
    "(optionally `focus=<path>`) to get ranked files and exports;",
    "use find/symbol/outline for targeted lookups.",
  ].join("\n");
  return {
    content,
    priority: "normal",
    essential: false,
    estimatedTokens: estimateTokens(content),
    kind: "project-map",
  };
}

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
export function formatMapOf(input: MapViewInput, result: IndexResult, focus?: string): string {
  let ranks = computeRanks(result);
  if (focus) {
    // focusRanks: «меньше — релевантнее»; selectByRank сортирует по убыванию.
    ranks = new Map<string, number>();
    for (const [path, rank] of focusRanks(result.files, focus)) {
      ranks.set(path, FOCUS_RANK_NONE - rank);
    }
  }
  return formatMapReport(result, {
    baseDir: input.baseDir,
    maxFiles: input.maxFiles,
    mapTokenBudget: input.mapTokenBudget,
    ranks,
    summary: input.summarize(result),
    stackLine: buildProjectProfileLine(input.baseDir),
  });
}

/** Файлы индекса (только чтение) для внешних потребителей. */
export function filesOf(index: IndexResult | null): IndexedFile[] {
  return index?.files ?? [];
}
