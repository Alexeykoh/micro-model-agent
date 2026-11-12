import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ProjectMapInfo } from "../../core/host";
import type { ToolDefinition } from "../../tools/types";
import { Indexer, DEFAULT_MAX_FILES, type IndexResult, type IndexedFile } from "./walker";
import { IndexCache } from "./cache";
import { estimateTokens } from "../../llm/token-counter";

import { createProjectMapTool, type MapToolHost } from "./map-tool";
import { buildMapToolHost } from "./map-tool-host";
import { mapInfoOf, formatMapOf, type MapViewInput } from "./map-info";
import { findFiles, findText, hasIndexedSymbols, outlineText, symbolsText } from "./queries";
import { IndexWatch } from "./watch";
import type { SymbolProvider } from "./provider";

export type { SymbolLocationHit, SymbolProvider } from "./provider";

/** Опции модуля индексатора: корень проекта, каталог кэша, кап файлов. */
export interface IndexerModuleOptions {
  baseDir: string;
  cacheDir: string;
  /** Кап индексируемых файлов (из `config.indexer.maxFiles`). */
  maxFiles?: number;
  /** Следовать `.gitignore`/`.mmaignore` корня проекта (default true). */
  respectGitignore?: boolean;
  /** Токен-бюджет списка файлов карты (PageRank-отбор; см. selectByRank). */
  mapTokenBudget?: number;
  logger?: import("../../logger/app-logger").Logger;
}

/** Дефолтный токен-бюджет списка файлов карты. */
const MAP_TOKEN_BUDGET = 1500;

/**
 * Бюджет карты на больших окнах (L2): 1500 токенов — это 1% окна 200K,
 * модель получает выжимку вместо карты. Явное значение конфига побеждает;
 * дефолт масштабируется (см. `effectiveMapTokenBudget` в workspace-фазе).
 */
export const LARGE_MAP_TOKEN_BUDGET = 6000;

/**
 * Эффективный бюджет карты (L2): явный конфиг — как есть; дефолт на большом
 * окне поднимается до `LARGE_MAP_TOKEN_BUDGET`. Чистая — тестируется отдельно.
 */
export function effectiveMapTokenBudget(
  configured: number | undefined,
  defaultBudget: number,
  contextWindow: number,
  largeWindowThreshold: number,
): number {
  if (configured !== undefined && configured !== defaultBudget) return configured;
  return contextWindow >= largeWindowThreshold ? LARGE_MAP_TOKEN_BUDGET : defaultBudget;
}

/** Модуль индексатора: кэш, карта проекта для промпта, тул project_map, вотчер. */
export class IndexerModule implements AgentModule {
  name = "indexer";
  private indexer: Indexer;
  private watcher: IndexWatch;
  private cache: IndexCache;
  private baseDir: string;
  private maxFiles: number;
  private mapTokenBudget: number;
  private index: IndexResult | null = null;
  private symbolProvider: SymbolProvider | null = null;
  private mapCache: { index: IndexResult; value: ProjectMapInfo } | null = null;
  private buildPromise: Promise<IndexResult | null> | null = null;
  private indexing = false;
  private forceRebuild = false; // refresh: кэш берётся только для reuse
  private builtAt: number | null = null;
  constructor(opts: IndexerModuleOptions) {
    this.baseDir = opts.baseDir;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.mapTokenBudget = opts.mapTokenBudget ?? MAP_TOKEN_BUDGET;
    this.indexer = new Indexer(opts.baseDir, {
      maxFiles: this.maxFiles,
      respectGitignore: opts.respectGitignore,
      logger: opts.logger,
    });
    this.watcher = new IndexWatch(this.indexer, () => this.refresh());
    // Кэш по сигнатуре дерева: совпала — без обхода; иначе walk(prev) инкрементально.
    this.cache = new IndexCache(opts.cacheDir, {
      root: opts.baseDir,
      signature: () => this.indexer.scanSignature(),
    });
  }

  /** Внешний источник определений (LSP); null — отключить. */
  setSymbolProvider(provider: SymbolProvider | null): void {
    this.symbolProvider = provider;
  }

  private lastBuildError: string | null = null;
  /** Честный health: ошибка стройки → degraded (INV-6). */
  health(): { status: "ok" | "degraded" | "failed"; reason?: string } {
    if (this.lastBuildError) {
      return { status: "degraded", reason: `index build failed: ${this.lastBuildError}` };
    }
    return { status: "ok" };
  }

  /** Строит индекс (кэш → обход), null при неустранимой ошибке. */
  buildIndex(): Promise<IndexResult | null> {
    if (!this.forceRebuild) {
      if (this.index) return Promise.resolve(this.index);
      const cached = this.cache.load();
      if (cached) {
        this.index = cached;
        this.builtAt = this.cache.getBuiltAt();
        return Promise.resolve(cached);
      }
    }
    if (this.buildPromise) return this.buildPromise;

    const prev = this.cache.loadForReuse();
    this.indexing = true;
    this.buildPromise = (async () => {
      try {
        const result = await this.indexer.walk(prev);
        // F-06: пустой workspace не получает `.mma/` до первого наполнения
        // (иначе ломается `create-next-app .`). Память индекса всё равно заполнена.
        if (result.files.length > 0) this.cache.save(result);
        this.index = result;
        this.builtAt = Date.now();
        this.lastBuildError = null;
        return result;
      } catch (err) {
        this.lastBuildError = err instanceof Error ? err.message : String(err);
        return null;
      } finally {
        this.indexing = false;
        this.buildPromise = null;
      }
    })();
    return this.buildPromise;
  }

  /** Перестройка с переиспользованием кэша; индекс не гасится до завершения. */
  async refresh(): Promise<IndexResult | null> {
    this.builtAt = null;
    this.forceRebuild = true;
    try {
      return await this.buildIndex();
    } finally {
      this.forceRebuild = false;
    }
  }

  /** Полная пересборка с нуля (явный `--reindex`): кэш сбрасывается. */
  async reindex(): Promise<IndexResult | null> {
    this.cache.invalidate();
    this.index = null;
    this.builtAt = null;
    this.forceRebuild = true;
    try {
      return await this.buildIndex();
    } finally {
      this.forceRebuild = false;
    }
  }

  /** Ищет файлы по символу/пути, ранжированно (пусто без индекса). */
  find(query: string): IndexedFile[] {
    return findFiles(this.index, query);
  }

  /** Человеко/модельно-читаемый результат `find` (общий для тула и `mma map`). */
  formatFind(query: string): string {
    return findText(this.index, query);
  }

  /** Ранжированный список мест определения символа (`path:line name (kind)`). */
  formatSymbols(query: string): string {
    return symbolsText(this.index, query);
  }

  /** Оглавление файла: символы с номерами строк (без чтения тела). */
  formatOutline(query: string): string {
    return outlineText(this.index, query);
  }

  /** Точный текст карты проекта для системного промпта (null без индекса). */
  getPromptMap(): string | null {
    return this.index ? this.formatMap(this.index) : null;
  }

  /**
   * Подписка на изменения файлов с дебаунсом перестройки (best-effort).
   * `onSettled` зовётся после отреагировавшей пересборки (или её ошибки) —
   * веб-вкладка Files по нему перечитывает раскрытые папки.
   */
  watch(onSettled?: () => void): void {
    this.watcher.start(onSettled);
  }

  /** Отписывается от вотчера и чистит дебаунс-таймер. */
  unwatch(): void {
    this.watcher.stop();
  }

  /** Блок системного промпта с картой проекта (null без индекса). */
  getSystemPromptBlock(): PromptBlock | null {
    if (!this.index) return null;
    const content = this.formatMap(this.index);
    return {
      content,
      priority: "normal",
      essential: false,
      estimatedTokens: estimateTokens(content),
      kind: "project-map",
    };
  }

  /**
   * Полная статистика карты для сайдбара: счётчики, время сборки, разбивка по
   * языкам, статус вотчера/обхода. Кэшируется на объект индекса, чтобы поллинг
   * `/api/state` не пересобирал разбивку.
   */
  mapInfo(): ProjectMapInfo {
    if (this.mapCache && this.index && this.mapCache.index === this.index) {
      return { ...this.mapCache.value, indexing: this.indexing, watcher: this.watcher.active };
    }
    const info = mapInfoOf(this.mapView());
    if (this.index) {
      this.mapCache = { index: this.index, value: info };
      return { ...info, indexing: this.indexing };
    }
    return info;
  }

  /** Срез состояния модуля для сборки карты (в `map-info.ts`). */
  private mapView(): MapViewInput {
    return {
      index: this.index,
      indexing: this.indexing,
      builtAt: this.builtAt,
      watcherActive: this.watcher.active,
      baseDir: this.baseDir,
      maxFiles: this.maxFiles,
      mapTokenBudget: this.mapTokenBudget,
      summarize: (result) => this.indexer.summarize(result),
    };
  }

  /** Компактная статистика карты для совместимости (null до конца обхода). */
  stats(): { files: number; symbols: number; tokens: number } | null {
    const info = this.mapInfo();
    return info.indexed ? { files: info.files, symbols: info.symbols, tokens: info.tokens } : null;
  }

  /** Определения тулов модуля (project_map). */
  getToolDefinitions(): ToolDefinition[] {
    return [createProjectMapTool(this.mapToolHost())];
  }

  /** Плагин модуля: индекс + вотчер на старт сессии, отписка на конец. */
  getPlugin(): AgentPlugin {
    return {
      name: "indexer",
      description: "workspace file index used by search and the project map",
      onSessionStart: () => {
        this.buildIndex().catch(() => {});
        this.watch();
      },
      onSessionEnd: () => {
        this.unwatch();
      },
    };
  }

  /** Текст отчёта «карта проекта» (формат — в `map-report.ts`). */
  private formatMap(result: IndexResult): string {
    return formatMapOf(this.mapView(), result);
  }

  /** Узкий срез модуля для `project_map` (сборка — в map-tool-host.ts). */
  private mapToolHost(): MapToolHost {
    return buildMapToolHost({
      baseDir: this.baseDir,
      buildIndex: () => this.buildIndex(),
      refresh: () => this.refresh(),
      getIndex: () => this.index,
      summarize: (result) => this.indexer.summarize(result),
      hasIndexedSymbols: (query) => this.hasIndexedSymbols(query),
      getSymbolProvider: () => this.symbolProvider,
      preferredLanguage: () => this.mapInfo().languages?.[0]?.language ?? "typescript",
      formatFind: (query) => this.formatFind(query),
      formatSymbols: (query) => this.formatSymbols(query),
      formatOutline: (query) => this.formatOutline(query),
    });
  }

  private hasIndexedSymbols(query: string): boolean {
    return hasIndexedSymbols(this.index, query);
  }
}
