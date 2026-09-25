import { dirname } from "path";
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition, ToolContext, ToolResult } from "../../tools/types";
import { Indexer } from "./walker";
import { IndexCache } from "./cache";
import { selectMapFiles } from "./map-select";
import { buildProjectProfileLine } from "./project-profile";
import type { IndexResult, IndexedFile } from "./walker";
import { t } from "../../i18n/index";
import { toForwardSlash } from "../../tools/path-utils";
import { estimateTokens } from "../../llm/token-counter";

export interface IndexerModuleOptions {
  baseDir: string;
  cacheDir: string;
}

/** Max files listed in the project-map prompt block (code first; see map-select). */
const MAP_FILE_LIMIT = 80;

export class IndexerModule implements AgentModule {
  name = "indexer";

  private indexer: Indexer;
  private cache: IndexCache;
  private baseDir: string;
  private index: IndexResult | null = null;
  private statsCache: { index: IndexResult; value: { files: number; symbols: number; tokens: number } } | null = null;
  private rebuildTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: IndexerModuleOptions) {
    this.baseDir = opts.baseDir;
    this.indexer = new Indexer(opts.baseDir);
    // Tie the cache to this project root + current tree signature so a stale
    // `index-cache.json` (files added/removed/edited since the walk) is rebuilt
    // instead of leaking an outdated map into the system prompt.
    this.cache = new IndexCache(opts.cacheDir, {
      root: opts.baseDir,
      signature: () => this.indexer.scanSignature(),
    });
  }

  async buildIndex(): Promise<IndexResult | null> {
    if (this.index) return this.index;

    const cached = this.cache.load();
    if (cached) {
      this.index = cached;
      return cached;
    }

    try {
      const result = await this.indexer.walk();
      this.cache.save(result);
      this.index = result;
      return result;
    } catch {
      return null;
    }
  }

  async refresh(): Promise<IndexResult | null> {
    this.cache.invalidate();
    this.index = null;
    return this.buildIndex();
  }

  find(query: string): IndexedFile[] {
    if (!this.index) return [];
    const q = query.toLowerCase();
    return this.index.files.filter((f) => {
      const path = f.path.toLowerCase();
      return path.includes(q) || f.exports.some((e) => e.toLowerCase().includes(q));
    });
  }

  /** Human/model-readable result of a `find` query (shared by the tool and `mma map`). */
  formatFind(query: string): string {
    const matches = this.find(query);
    if (matches.length === 0) {
      return t("indexer.no_matches", { query });
    }
    const lines = matches
      .map((f) => {
        const path = toForwardSlash(f.path);
        const exports = f.exports.length > 0 ? `: ${f.exports.join(", ")}` : "";
        return `- ${path}${exports}`;
      })
      .join("\n");
    return t("indexer.find_results", { count: matches.length, results: lines });
  }

  /** The exact project-map text injected into the system prompt (null if not indexed). */
  getPromptMap(): string | null {
    return this.index ? this.formatMap(this.index) : null;
  }

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
    } catch {
      // Watching is best-effort; manual refresh still works.
    }
  }

  unwatch(): void {
    if (this.rebuildTimeout) {
      clearTimeout(this.rebuildTimeout);
      this.rebuildTimeout = null;
    }
    this.indexer.unwatch();
  }

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
   * Compact project-map stats for the host sidebar (`null` before the walk
   * finishes). Cached per index object so `/api/state` polling never re-renders
   * the whole map.
   */
  stats(): { files: number; symbols: number; tokens: number } | null {
    if (!this.index) return null;
    if (this.statsCache && this.statsCache.index === this.index) return this.statsCache.value;
    const symbols = this.index.files.reduce((n, f) => n + f.exports.length, 0);
    const value = {
      files: this.index.files.length,
      symbols,
      tokens: this.estimateTokens(this.formatMap(this.index)),
    };
    this.statsCache = { index: this.index, value };
    return value;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [this.createProjectMapTool()];
  }

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

    return [
      `${t("indexer.map_header")} (${this.baseDir})`,
      summary,
      ...(stackLine ? [stackLine] : []),
      `${t("indexer.top_directories")}: ${topDirs}`,
      ...(duplicates.length > 0 ? [t("indexer.duplicates", { names: duplicates.join(", ") })] : []),
      `${t("indexer.files")}:` + (fileLines.length > 0 ? "" : " " + t("indexer.empty")),
      ...fileLines,
      more,
    ].join("\n");
  }

  /**
   * Find files that share a basename across different extensions in the same
   * directory (e.g. `ProductCard.js` + `ProductCard.tsx`). This is a purely
   * structural fact about the file tree — a stale transpiled twin may shadow
   * the real source at build time. Flagging it is not task classification, so
   * it does not violate the no-keyword-matching rule; the model decides what
   * to do with the information.
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
            enum: ["summary", "refresh", "find"],
            description: t("indexer.project_map_action_desc"),
          },
          query: {
            type: "string",
            description: t("indexer.project_map_query_desc"),
          },
        },
        required: ["action"],
      },
      handler: async (_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
        const action = String(args.action || "summary");

        if (action === "refresh") {
          const result = await this.refresh();
          const summary = result ? this.indexer.summarize(result) : t("indexer.empty");
          const stackLine = result ? buildProjectProfileLine(this.baseDir) : null;
          const output = summary && stackLine ? `${summary}\n${stackLine}` : summary;
          return this.makeResult(t("indexer.refreshed", { summary: output }));
        }

        if (action === "find") {
          const query = String(args.query || "").toLowerCase();
          if (!query) return { success: false, output: t("tool.invalid_params") };
          return this.makeResult(this.formatFind(query));
        }

        if (!this.index) {
          await this.buildIndex();
        }
        if (!this.index) {
          return this.makeResult(t("indexer.not_indexed"));
        }
        const summary = this.indexer.summarize(this.index);
        const stackLine = buildProjectProfileLine(this.baseDir);
        const output = summary && stackLine ? `${summary}\n${stackLine}` : summary;
        return this.makeResult(t("indexer.summary", { summary: output }));
      },
    };
  }

  private makeResult(output: string): ToolResult {
    return { success: true, output, display: output };
  }
}
