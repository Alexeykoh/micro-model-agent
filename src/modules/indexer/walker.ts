import {
  readdirSync,
  readFileSync,
  statSync,
  lstatSync,
  existsSync,
  watch,
  type FSWatcher,
  type Stats,
} from "fs";
import { createHash } from "node:crypto";
import { join, relative, extname } from "path";
import { Logger } from "../../logger/app-logger";
import { languageIdForExt, extractSymbols } from "./symbols";
import { t } from "../../i18n/index";

const logger = new Logger("warn", "indexer");

/**
 * Directories that never hold project source but would flood the index:
 * VCS/build output, package caches and virtual environments across
 * ecosystems (Node, Python, Rust, Go/PHP/Ruby, JVM, .NET, Apple, IDE).
 * Stored lowercase — matching is case-insensitive (Windows/macOS).
 */
const IGNORE_DIRS = new Set([
  // VCS / MMA
  ".git",
  ".hg",
  ".svn",
  ".mma",
  // Node / JS bundlers
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  // Python
  "venv",
  ".venv",
  "env",
  "virtualenv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "site-packages",
  // Rust
  "target",
  // Go / PHP / Ruby
  "vendor",
  ".bundle",
  // JVM
  ".gradle",
  "out",
  // .NET
  "obj",
  // Apple
  "pods",
  "deriveddata",
  // IDE / editor
  ".idea",
  ".vscode",
]);

/** True when a directory name is ignored (case-insensitive). */
export function isIgnoredDirName(name: string): boolean {
  return IGNORE_DIRS.has(name.toLowerCase());
}

/**
 * True when any path SEGMENT is an ignored directory. Segment-based (not a
 * substring) so short names like `env`/`out`/`obj` do not black out
 * `environment.ts` or `about/`.
 */
function isIgnoredPath(filename: string): boolean {
  return filename.split(/[\\/]/).some((segment) => isIgnoredDirName(segment));
}

export interface IndexedFile {
  path: string;
  language: string;
  exports: string[];
  size: number;
}

export interface IndexResult {
  files: IndexedFile[];
  totalSize: number;
}

export class Indexer {
  private baseDir: string;
  private MAX_FILES = 1000;
  private watcher: FSWatcher | null = null;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  watch(callback: (event: string, filename: string | null) => void): void {
    this.watcher = watch(this.baseDir, { recursive: true }, (event, filename) => {
      if (filename && !isIgnoredPath(filename)) {
        callback(event, filename);
      }
    });
  }

  unwatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Traverse every indexable source file under `baseDir` and invoke `visit`
   * with its full path, project-relative path, language id and stat. Honors
   * `MAX_FILES` and `IGNORE_DIRS`; file contents are NOT read here — `walk()`
   * reads them for symbol extraction, while `scanSignature()` uses the stat
   * only. Shared so both passes see exactly the same file set.
   */
  private eachSourceFile(
    visit: (fullPath: string, relPath: string, language: string, stat: Stats) => void,
  ): void {
    let count = 0;

    const walkDir = (dir: string): void => {
      if (!existsSync(dir)) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (count >= this.MAX_FILES) return;
        const fullPath = join(dir, entry);
        const relPath = relative(this.baseDir, fullPath);
        // Per-entry isolation: a file deleted (or unreadable) between readdir
        // and stat must not kill the whole walk. Symlinks are skipped — they
        // can point outside the project or create directory cycles.
        try {
          const lst = lstatSync(fullPath, { throwIfNoEntry: false });
          if (!lst || lst.isSymbolicLink()) continue;
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            if (!isIgnoredDirName(entry)) {
              walkDir(fullPath);
            }
          } else if (stat.isFile()) {
            const language = languageIdForExt(extname(entry).toLowerCase());
            if (language) {
              visit(fullPath, relPath, language, stat);
              count++;
            }
          }
        } catch (e) {
          // Entry vanished or is unreadable — skip it, keep indexing the rest.
          logger.warn(t("env.index_skip_unreadable", { path: relPath }), { error: String(e) });
        }
      }
    };

    walkDir(this.baseDir);
  }

  async walk(): Promise<IndexResult> {
    const files: IndexedFile[] = [];
    let totalSize = 0;

    this.eachSourceFile((fullPath, relPath, language, stat) => {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const exports = extractSymbols(content, language);
        files.push({ path: relPath, language, exports, size: stat.size });
        totalSize += stat.size;
      } catch (e) {
        // Read failed after a successful stat — skip the file, keep the rest.
        logger.warn(t("env.index_skip_unreadable", { path: relPath }), { error: String(e) });
      }
    });

    return { files, totalSize };
  }

  /**
   * Cheap, content-free fingerprint of the indexed tree: sorted
   * `path\0size\0mtimeMs` hashed with SHA-1. `IndexCache` stores it and
   * re-computes it on load to reject a stale `index-cache.json` (a file added,
   * removed or edited since the walk changes the signature). Stat-only — no
   * file reads, so it is far cheaper than a full walk.
   */
  scanSignature(): string {
    const parts: string[] = [];
    this.eachSourceFile((_fullPath, relPath, _language, stat) => {
      parts.push(`${relPath}\u0000${stat.size}\u0000${Math.floor(stat.mtimeMs)}`);
    });
    parts.sort();
    return createHash("sha1").update(parts.join("\n")).digest("hex");
  }

  summarize(result: IndexResult): string {
    const byLang: Record<string, number> = {};
    for (const f of result.files) {
      byLang[f.language] = (byLang[f.language] || 0) + 1;
    }
    const langs = Object.entries(byLang)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang}:${count}`)
      .join(", ");

    return `[Index: ${result.files.length} files, ${(result.totalSize / 1024).toFixed(1)}KB (${langs})]`;
  }
}
