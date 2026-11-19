/**
 * Срез индексатора для тула `project_map` (правило ≤300 строк).
 *
 * Вынесено из `module.ts`: узкий host без кэша/вотчера/полей — только те
 * операции, которые тул реально вызывает. Модуль передаёт геттеры.
 */
import type { IndexResult } from "./walker";
import type { MapToolHost } from "./map-tool"; // eslint-disable-line -- тип-контракт

/** Геттеры модуля, из которых собирается host тула. */
export interface MapToolHostInput {
  baseDir: string;
  buildIndex: () => Promise<IndexResult | null>;
  refresh: () => Promise<IndexResult | null>;
  getIndex: () => IndexResult | null;
  summarize: (result: IndexResult) => string;
  hasIndexedSymbols: (query: string) => boolean;
  getSymbolProvider: () => unknown;
  preferredLanguage: () => string;
  formatFind: (query: string) => string;
  formatSymbols: (query: string) => string;
  formatOutline: (query: string) => string;
}

/** Собирает узкий host тула `project_map`. */
export function buildMapToolHost(input: MapToolHostInput): MapToolHost {
  return {
    baseDir: input.baseDir,
    buildIndex: input.buildIndex,
    refresh: input.refresh,
    getIndex: input.getIndex,
    summarize: input.summarize,
    hasIndexedSymbols: input.hasIndexedSymbols,
    getSymbolProvider: input.getSymbolProvider,
    preferredLanguage: input.preferredLanguage,
    formatFind: input.formatFind,
    formatSymbols: input.formatSymbols,
    formatOutline: input.formatOutline,
  } as MapToolHost;
}
