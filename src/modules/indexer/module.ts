// Модуль индексатора: построение карты проекта, тул project_map, вотчер.
import { dirname } from "path";
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ProjectMapInfo } from "../../core/host";
import type { ToolDefinition, ToolContext, ToolResult } from "../../tools/types";
import { Indexer, DEFAULT_MAX_FILES } from "./walker";
import { IndexCache } from "./cache";
import { selectMapFiles } from "./map-select";
import { buildProjectProfileLine } from "./project-profile";
import { rankFiles, rankSymbols, matchOutline } from "./rank";
import type { IndexResult, IndexedFile } from "./walker";
import { t } from "../../i18n/index";
import { toForwardSlash } from "../../tools/path-utils";
import { estimateTokens } from "../../llm/token-counter";

/** Опции модуля индексатора: корень проекта, каталог кэша, кап файлов. */
export interface IndexerModuleOptions {
  baseDir: string;
  cacheDir: string;
  /** Кап индексируемых файлов (из `config.indexer.maxFiles`). */
  maxFiles?: number;
  /** Следовать `.gitignore`/`.mmaignore` корня проекта (default true). */
  respectGitignore?: boolean;
}

/** Макс. файлов в блоке карты проекта (сначала код; см. map-select). */
const MAP_FILE_LIMIT = 80;

/** Макс. строк в результатах find/symbol (хвост — счётчиком). */
const FIND_LIMIT = 50;

/** Макс. символов в outline одного файла. */
const OUTLINE_LIMIT = 80;

/** Модуль индексатора: кэш, карта проекта для промпта, тул project_map, вотчер. */
export class IndexerModule implements AgentModule {
  name = "indexer";

  private indexer: Indexer;
  private cache: IndexCache;
  private baseDir: string;
  private maxFiles: number;
  private index: IndexResult | null = null;
  private mapCache: { index: IndexResult; value: ProjectMapInfo } | null = null;
  private buildPromise: Promise<IndexResult | null> | null = null;
  private indexing = false;
  private builtAt: number | null = null;
  private watcherActive = false;
  private rebuildTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: IndexerModuleOptions) {
    this.baseDir = opts.baseDir;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.indexer = new Indexer(opts.baseDir, {
      maxFiles: this.maxFiles,
      respectGitignore: opts.respectGitignore,
    });
    // Кэш привязан к корню проекта + сигнатуре дерева: совпала — отдаём индекс
    // без обхода. На расхождении `walk(prev)` делает инкрементальный пересбор
    // (совпавшие `size`/`mtimeMs` не читаются, изменённые — перечитываются),
    // поэтому «правка одного файла» не перечитывает весь проект.
    this.cache = new IndexCache(opts.cacheDir, {
      root: opts.baseDir,
      signature: () => this.indexer.scanSignature(),
    });
  }

  /** Строит индекс (кэш → обход), null при неустранимой ошибке. */
  buildIndex(): Promise<IndexResult | null> {
    if (this.index) return Promise.resolve(this.index);
    if (this.buildPromise) return this.buildPromise;

    const cached = this.cache.load();
    if (cached) {
      this.index = cached;
      this.builtAt = this.cache.getBuiltAt();
      return Promise.resolve(cached);
    }

    const prev = this.cache.loadForReuse();
    this.indexing = true;
    this.buildPromise = (async () => {
      try {
        const result = await this.indexer.walk(prev);
        this.cache.save(result);
        this.index = result;
        this.builtAt = Date.now();
        return result;
      } catch {
        return null;
      } finally {
        this.indexing = false;
        this.buildPromise = null;
      }
    })();
    return this.buildPromise;
  }

  /** Принудительно перестраивает индекс (сброс кэша + обход). */
  async refresh(): Promise<IndexResult | null> {
    this.cache.invalidate();
    this.index = null;
    this.builtAt = null;
    return this.buildIndex();
  }

  /** Ищет файлы по символу/пути, ранжированно (пусто без индекса). */
  find(query: string): IndexedFile[] {
    if (!this.index) return [];
    return rankFiles(this.index.files, query).map((r) => r.file);
  }

  /** Человеко/модельно-читаемый результат `find` (общий для тула и `mma map`). */
  formatFind(query: string): string {
    const matches = this.find(query);
    if (matches.length === 0) {
      return t("indexer.no_matches", { query });
    }
    const shown = matches.slice(0, FIND_LIMIT);
    const lines = shown
      .map((f) => {
        const path = toForwardSlash(f.path);
        const exports = f.exports.length > 0 ? `: ${f.exports.join(", ")}` : "";
        return `- ${path}${exports}`;
      })
      .join("\n");
    const more =
      matches.length > shown.length
        ? `\n${t("indexer.find_more", { count: matches.length - shown.length })}`
        : "";
    return t("indexer.find_results", { count: matches.length, results: lines + more });
  }

  /** Ранжированный список мест определения символа (`path:line name (kind)`). */
  formatSymbols(query: string): string {
    if (!this.index) return t("indexer.not_indexed");
    const hits = rankSymbols(this.index.files, query);
    if (hits.length === 0) return t("indexer.no_matches", { query });
    const shown = hits.slice(0, FIND_LIMIT);
    const lines = shown
      .map((h) => `- ${toForwardSlash(h.file.path)}:${h.line} ${h.name} (${h.kind})`)
      .join("\n");
    const more =
      hits.length > shown.length
        ? `\n${t("indexer.find_more", { count: hits.length - shown.length })}`
        : "";
    return t("indexer.symbol_results", { count: hits.length, results: lines + more });
  }

  /** Оглавление файла: символы с номерами строк (без чтения тела). */
  formatOutline(query: string): string {
    if (!this.index) return t("indexer.not_indexed");
    const file = matchOutline(this.index.files, query);
    if (!file) return t("indexer.no_matches", { query });
    const path = toForwardSlash(file.path);
    if (file.symbols.length === 0) {
      return `${path}\n${t("indexer.outline_empty")}`;
    }
    const shown = file.symbols.slice(0, OUTLINE_LIMIT);
    const lines = shown.map((s) => `  ${s.line}: ${s.name} (${s.kind})`).join("\n");
    const more =
      file.symbols.length > shown.length
        ? `\n${t("indexer.find_more", { count: file.symbols.length - shown.length })}`
        : "";
    return `${path}\n${lines}${more}`;
  }

  /** Точный текст карты проекта для системного промпта (null без индекса). */
  getPromptMap(): string | null {
    return this.index ? this.formatMap(this.index) : null;
  }

  /** Подписка на изменения файлов с дебаунсом перестройки (best-effort). */
  watch(): void {
    this.unwatch();
    try {
      this.indexer.watch((_event, filename) => {
        if (!filename) return;
        if (this.rebuildTimeout) clearTimeout(this.rebuildTimeout);
        this.rebuildTimeout = setTimeout(() => {
          this.refresh().catch(() => {});
        }, 2000);
      });
      this.watcherActive = true;
    } catch {
      // Вотчинг best-effort; ручной refresh всё равно работает.
    }
  }

  /** Отписывается от вотчера и чистит дебаунс-таймер. */
  unwatch(): void {
    this.watcherActive = false;
    if (this.rebuildTimeout) {
      clearTimeout(this.rebuildTimeout);
      this.rebuildTimeout = null;
    }
    this.indexer.unwatch();
  }

  /** Блок системного промпта с картой проекта (null без индекса). */
  getSystemPromptBlock(): PromptBlock | null {
    if (!this.index) return null;
    const content = this.formatMap(this.index);
    return {
      content,
      priority: "normal",
      essential: false,
      estimatedTokens: this.estimateTokens(content),
      kind: "project-map",
    };
  }

  /**
   * Полная статистика карты для сайдбара: счётчики, время сборки, разбивка по
   * языкам, статус вотчера/обхода. Кэшируется на объект индекса, чтобы поллинг
   * `/api/state` не пересобирал разбивку.
   */
  mapInfo(): ProjectMapInfo {
    if (!this.index) {
      return {
        indexed: false,
        indexing: this.indexing,
        files: 0,
        symbols: 0,
        tokens: 0,
        updatedAt: this.builtAt,
        languages: [],
        watcher: this.watcherActive,
      };
    }
    if (this.mapCache && this.mapCache.index === this.index) {
      return { ...this.mapCache.value, indexing: this.indexing, watcher: this.watcherActive };
    }
    const symbols = this.index.files.reduce((n, f) => n + f.exports.length, 0);
    const langMap = new Map<string, { files: number; symbols: number }>();
    for (const f of this.index.files) {
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
    const value: ProjectMapInfo = {
      indexed: true,
      files: this.index.files.length,
      symbols,
      tokens: this.estimateTokens(this.formatMap(this.index)),
      updatedAt: this.builtAt,
      languages,
      watcher: this.watcherActive,
    };
    this.mapCache = { index: this.index, value };
    return { ...value, indexing: this.indexing };
  }

  /** Компактная статистика карты для совместимости (null до конца обхода). */
  stats(): { files: number; symbols: number; tokens: number } | null {
    const info = this.mapInfo();
    return info.indexed ? { files: info.files, symbols: info.symbols, tokens: info.tokens } : null;
  }

  /** Определения тулов модуля (project_map). */
  getToolDefinitions(): ToolDefinition[] {
    return [this.createProjectMapTool()];
  }

  /** Плагин модуля: индекс + вотчер на старт сессии, отписка на конец. */
  getPlugin(): AgentPlugin {
    return {
      name: "indexer",
      onSessionStart: () => {
        this.buildIndex().catch(() => {});
        this.watch();
      },
      onSessionEnd: () => {
        this.unwatch();
      },
    };
  }

  private formatMap(result: IndexResult): string {
    const summary = this.indexer.summarize(result);
    const stackLine = buildProjectProfileLine(this.baseDir);
    const dirCounts = this.getDirectoryCounts(result);
    const topDirs =
      Object.entries(dirCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([dir, count]) => `${dir} (${count})`)
        .join(", ") || "-";

    const listed = selectMapFiles(result.files, MAP_FILE_LIMIT);
    const fileLines = listed.map((f) => {
      const path = toForwardSlash(f.path);
      const exports = f.exports.length > 0 ? `: ${f.exports.join(", ")}` : "";
      return `- ${path}${exports}`;
    });

    const more =
      result.files.length > listed.length
        ? `\n${t("indexer.and_more", { count: result.files.length - listed.length })}`
        : "";

    const duplicates = this.findDuplicateBasenames(result);

    const truncated = result.files.length >= this.maxFiles;

    return [
      `${t("indexer.map_header")} (${this.baseDir})`,
      summary,
      ...(truncated ? [t("indexer.truncated", { max: String(this.maxFiles) })] : []),
      ...(stackLine ? [stackLine] : []),
      `${t("indexer.top_directories")}: ${topDirs}`,
      ...(duplicates.length > 0 ? [t("indexer.duplicates", { names: duplicates.join(", ") })] : []),
      `${t("indexer.files")}:${fileLines.length > 0 ? "" : ` ${t("indexer.empty")}`}`,
      ...fileLines,
      more,
    ].join("\n");
  }

  /**
   * Находит файлы с общим basename при разных расширениях в одном каталоге
   * (напр. `ProductCard.js` + `ProductCard.tsx`). Чисто структурный факт дерева —
   * протухший транспилированный близнец может затенять реальный исходник на
   * сборке. Подсветить его — не классификация задач, правило no-keyword-matching
   * не нарушает; что делать с информацией — решает модель.
   */
  private findDuplicateBasenames(result: IndexResult): string[] {
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

  private getDirectoryCounts(result: IndexResult): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const f of result.files) {
      const normalized = toForwardSlash(f.path);
      const dir = dirname(normalized);
      const key = dir === "." ? "(root)" : dir;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  private estimateTokens(content: string): number {
    return estimateTokens(content);
  }

  private createProjectMapTool(): ToolDefinition {
    return {
      name: "project_map",
      icon: "🗺️",
      alwaysOn: true,
      description: t("indexer.project_map_desc"),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["summary", "refresh", "find", "symbol", "outline"],
            description: t("indexer.project_map_action_desc"),
          },
          query: {
            type: "string",
            description: t("indexer.project_map_query_desc"),
          },
        },
        required: ["action"],
      },
      handler: async (_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> =>
        this.runMapAction(String(args.action || "summary"), String(args.query || "")),
    };
  }

  /** Диспетчер действий `project_map` (handler-map, правило #17). */
  private runMapAction(action: string, rawQuery: string): Promise<ToolResult> | ToolResult {
    const query = rawQuery.trim();
    switch (action) {
      case "refresh":
        return this.refreshMap();
      case "find":
        return this.queryResult(query, () => this.formatFind(query));
      case "symbol":
        return this.queryResult(query, () => this.formatSymbols(query));
      case "outline":
        return this.queryResult(query, () => this.formatOutline(query));
      default:
        return this.summaryMap();
    }
  }

  /** `refresh`: пересборка индекса + сводка и профиль стека. */
  private async refreshMap(): Promise<ToolResult> {
    const result = await this.refresh();
    const summary = result ? this.indexer.summarize(result) : t("indexer.empty");
    const stackLine = result ? buildProjectProfileLine(this.baseDir) : null;
    const output = summary && stackLine ? `${summary}\n${stackLine}` : summary;
    return this.makeResult(t("indexer.refreshed", { summary: output }));
  }

  /** `summary`: гарантирует индекс и отдаёт сводку + профиль стека. */
  private async summaryMap(): Promise<ToolResult> {
    if (!this.index) await this.buildIndex();
    if (!this.index) return this.makeResult(t("indexer.not_indexed"));
    const summary = this.indexer.summarize(this.index);
    const stackLine = buildProjectProfileLine(this.baseDir);
    const output = summary && stackLine ? `${summary}\n${stackLine}` : summary;
    return this.makeResult(t("indexer.summary", { summary: output }));
  }

  /** Поисковое действие: проверяет запрос и индекс, отдаёт готовый текст. */
  private async queryResult(query: string, format: () => string): Promise<ToolResult> {
    if (!query) return { success: false, output: t("tool.invalid_params") };
    if (!this.index) await this.buildIndex();
    if (!this.index) return this.makeResult(t("indexer.not_indexed"));
    return this.makeResult(format());
  }

  private makeResult(output: string): ToolResult {
    return { success: true, output, display: output };
  }
}
