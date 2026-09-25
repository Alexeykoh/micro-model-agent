import { existsSync, readdirSync, type Dirent } from "fs";
import { resolve, isAbsolute, join } from "path";
import type { HallucinationCheckResult } from "./detector";
import { t } from "../../i18n/index";
import { extractFileLikeTokens, stripUrls } from "./js-identifiers";

/** Generated/cached dirs to skip when scanning for bare file names. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".mma",
  "_testing",
]);

export class FactualCheck {
  private baseDir: string;
  private nameCache: Map<string, string[]> | null = null;
  private nameCacheTime = 0;
  private lastRescan = 0;
  private static readonly NAME_CACHE_TTL_MS = 5_000;
  private static readonly RESCAN_COOLDOWN_MS = 2_000;
  private static readonly MAX_INDEXED_FILES = 20_000;
  /** Files known from compaction summaries — survive context resets. */
  private knownFiles = new Set<string>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Add file paths known from compaction summaries. These are checked
   *  before the filesystem scan so bare filenames from compacted turns
   *  are recognized even when the directory is in IGNORED_DIRS. */
  addKnownFiles(files: string[]): void {
    for (const f of files) this.knownFiles.add(f);
  }

  validate(response: string, deletedFiles?: Set<string>): HallucinationCheckResult {
    const filePaths = this.extractFilePaths(response);
    if (filePaths.length === 0) return { status: "pass" };

    const deletedBasenames = deletedFiles
      ? new Set([...deletedFiles].map((p) => p.split(/[/\\]/).pop() ?? p))
      : undefined;

    const nonExistent: string[] = [];
    for (const fp of filePaths) {
      if (deletedBasenames?.has(fp)) continue;
      if (!this.pathExists(fp)) {
        nonExistent.push(fp);
      }
    }

    if (nonExistent.length > 0) {
      return {
        status: "warn",
        reason: t("hall.unknown_paths", {
          paths: nonExistent.slice(0, 5).join(", "),
        }),
      };
    }

    return { status: "pass" };
  }

  /**
   * Bare filenames ("bikes.json") and relative paths ("src/data/bikes.json")
   * both land on the project tree. Absolute paths are checked as-is.
   */
  private pathExists(fp: string): boolean {
    if (isAbsolute(fp)) return existsSync(fp);

    // Check known files from compaction summaries first
    if (this.knownFiles.has(fp)) return true;

    for (const cand of this.dotfileVariants(fp)) {
      if (this.knownFiles.has(cand)) return true;
      if (existsSync(resolve(this.baseDir, cand))) return true;
    }

    // "foo.json" has no directory part — treat it as a bare name that may
    // live anywhere under baseDir (e.g. src/data/bikes.json). Resolving it
    // against the workspace root alone produced false "unknown file" warnings.
    if (!fp.includes("/") && !fp.includes("\\")) {
      return this.bareNameExists(fp);
    }

    return false;
  }

  /**
   * The token regex cannot anchor a leading dot (`\b` never matches between a
   * non-word char and `.`), so dotfiles (.prettierrc.json, .env, …) are
   * extracted as "prettierrc.json". Try the dot-prefixed basename too before
   * declaring the file missing. "src/config.json" also yields
   * "src/.config.json". For paths like "mma/index-cache.json", also try
   * ".mma/index-cache.json" (dot-prefixed parent directories).
   */
  private dotfileVariants(fp: string): string[] {
    const variants = [fp];
    const sep = fp.includes("\\") ? "\\" : "/";
    const parts = fp.split(sep);

    // Try dot-prefixing the basename (existing logic)
    const base = parts[parts.length - 1];
    if (!base.startsWith(".")) {
      const withDotBase = [...parts.slice(0, -1), `.${base}`].join(sep);
      variants.push(withDotBase);
    }

    // Try dot-prefixing each parent directory component
    for (let i = 0; i < parts.length - 1; i++) {
      if (!parts[i].startsWith(".")) {
        const dotted = [...parts.slice(0, i), `.${parts[i]}`, ...parts.slice(i + 1)].join(sep);
        if (!variants.includes(dotted)) variants.push(dotted);
      }
    }

    return variants;
  }

  private bareNameExists(name: string): boolean {
    for (const cand of this.dotfileVariants(name)) {
      if (existsSync(resolve(this.baseDir, cand))) return true;
      if (this.indexHas(cand)) return true;
      // Check known files — a bare name may match a full path from compaction
      for (const known of this.knownFiles) {
        if (known.endsWith(`/${cand}`) || known.endsWith(`\\${cand}`) || known === cand) {
          return true;
        }
      }
    }

    // Имя файла может содержать пробел: «отчёт 1.txt» извлекается токеном
    // «1.txt». Прежде чем объявлять файл отсутствующим, проверяем, не
    // заканчивается ли какое-то известное имя на « 1.txt».
    const spaceName = ` ${name}`;
    for (const known of this.knownFiles) {
      if (known.endsWith(spaceName)) return true;
    }
    for (const key of this.getNameIndex().keys()) {
      if (key.endsWith(spaceName)) return true;
    }

    // A write_file from this session may have created the file after the
    // index was built. Do a one-off rescan (rate-limited) before warning.
    const now = Date.now();
    if (now - this.lastRescan < FactualCheck.RESCAN_COOLDOWN_MS) return false;
    this.lastRescan = now;
    this.nameCache = null;
    this.nameCacheTime = 0;
    return this.indexHas(name);
  }

  private indexHas(name: string): boolean {
    return (this.getNameIndex().get(name)?.length ?? 0) > 0;
  }

  /**
   * Basename → paths index, rebuilt every NAME_CACHE_TTL_MS so newly created
   * files (write_file) are picked up without a full scan on every response.
   */
  private getNameIndex(): Map<string, string[]> {
    const now = Date.now();
    if (this.nameCache && now - this.nameCacheTime < FactualCheck.NAME_CACHE_TTL_MS) {
      return this.nameCache;
    }

    const index = new Map<string, string[]>();
    const scanned = this.scanDir(this.baseDir, index, 0);
    if (scanned > 0 || index.size > 0) {
      this.nameCache = index;
      this.nameCacheTime = now;
    }
    return index;
  }

  private scanDir(dir: string, index: Map<string, string[]>, count: number): number {
    if (count >= FactualCheck.MAX_INDEXED_FILES) return count;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return count;
    }
    for (const entry of entries) {
      if (count >= FactualCheck.MAX_INDEXED_FILES) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          count = this.scanDir(full, index, count);
        }
      } else if (entry.isFile()) {
        const list = index.get(entry.name);
        if (list) list.push(full);
        else index.set(entry.name, [full]);
        count++;
      }
    }
    return count;
  }

  private extractFilePaths(text: string): string[] {
    return extractFileLikeTokens(stripUrls(text));
  }
}
