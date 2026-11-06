import type { SymbolLocation } from "./symbols-types";

// Public shapes of the project walker (rule 6: kept out of the 300-line module).

export interface IndexedFile {
  path: string;
  language: string;
  exports: string[];
  /** Символы с позициями/kind (пусто у языков без извлечения). */
  symbols: SymbolLocation[];
  /** Сырые спецификаторы импорта — рёбра графа ссылок (PageRank). */
  imports?: string[];
  size: number;
  /** mtime файла (epoch ms) — ключ инкрементального переиспользования. */
  mtimeMs: number;
}

/** Результат обхода: файлы + суммарный размер. */
export interface IndexResult {
  files: IndexedFile[];
  totalSize: number;
}

/** Опции воркера: кап файлов и следование `.gitignore`/`.mmaignore`. */
export interface IndexerOptions {
  maxFiles?: number;
  respectGitignore?: boolean;
  /** Логгер модуля: без него предупреждения обхода не персистятся. */
  logger?: import("../../logger/app-logger").Logger;
}

/** Читает файл игноров из корня проекта; null при любой ошибке (fail-open). */
