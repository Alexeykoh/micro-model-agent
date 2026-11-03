// Обход дерева проекта: индекс файлов с символами, вотчер, сигнатура дерева.
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
import {
  languageIdForExt,
  extractSymbolsDetailed,
  extractImports,
} from "./symbols";
import { loadIgnoreMatcher, type IgnoreMatcher } from "./gitignore";
import { t } from "../../i18n/index";

const logger = new Logger("warn", "indexer");

/** Дефолтный кап файлов, если вызывающий не задал (см. `config.indexer.maxFiles`). */
export const DEFAULT_MAX_FILES = 1000;

/**
 * Каталоги, где исходников проекта не бывает, но индекс бы утонул:
 * VCS/артефакты сборки, кэши пакетов и виртуалки всех экосистем
 * (Node, Python, Rust, Go/PHP/Ruby, JVM, .NET, Apple, IDE).
 * Хранятся в lowercase — сравнение регистронезависимо (Windows/macOS).
 */
import { isIgnoredDirName, isIgnoredFileName, isIgnoredPath } from "./ignore";
export { isIgnoredDirName, isIgnoredFileName } from "./ignore";

export type { IndexedFile, IndexResult, IndexerOptions } from "./walker-types";
import type { IndexedFile, IndexResult, IndexerOptions } from "./walker-types";

function readIgnoreFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Индексер: обход исходников, вотчер, сигнатура дерева, сводка. */
export class Indexer {
  private baseDir: string;
  private maxFiles: number;
  private ignores: IgnoreMatcher;
  private watcher: FSWatcher | FSWatcher[] | null = null;

  constructor(baseDir: string, opts: IndexerOptions = {}) {
    this.baseDir = baseDir;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.ignores =
      opts.respectGitignore === false
        ? { ignores: () => false }
        : loadIgnoreMatcher(baseDir, readIgnoreFile);
  }

  /** Подписка на изменения дерева (игнорируемые пути не пробрасываются). */
  watch(callback: (event: string, filename: string | null) => void): void {
    const handler = (event: string, filename: string | null): void => {
      if (filename && !isIgnoredPath(filename)) {
        callback(event, filename);
      }
    };
    try {
      // Рекурсивный вотч работает на macOS/Windows; на Linux опция игнорируется
      // или бросает в зависимости от сборки Node — ниже фолбэк.
      this.watcher = watch(this.baseDir, { recursive: true }, handler);
    } catch {
      this.watcher = this.watchNonRecursive(handler);
    }
  }

  /**
   * Linux-фолбэк: `fs.watch(recursive)` только для macOS/Windows, поэтому
   * смотрим каждый неигнорируемый подкаталог отдельно (нерекурсивно).
   * Best-effort: подкаталоги, созданные после `watch()`, требуют ручного refresh.
   */
  private watchNonRecursive(
    callback: (event: string, filename: string | null) => void,
  ): FSWatcher[] {
    const watchers: FSWatcher[] = [];
    const collectDirs = (dir: string, out: string[]): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      out.push(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const lst = lstatSync(fullPath, { throwIfNoEntry: false });
          if (!lst || lst.isSymbolicLink()) continue;
          if (statSync(fullPath).isDirectory() && !isIgnoredDirName(entry)) {
            collectDirs(fullPath, out);
          }
        } catch {
          // Нечитаемая запись — пропускаем, идём по остальным.
        }
      }
    };
    const dirs: string[] = [];
    collectDirs(this.baseDir, dirs);
    for (const dir of dirs) {
      try {
        watchers.push(watch(dir, callback));
      } catch (e) {
        logger.warn(`watch failed for ${dir}: ${(e as Error).message}`);
      }
    }
    if (watchers.length === 0) {
      logger.warn("file watcher unavailable: no directories could be watched");
    }
    return watchers;
  }

  /** Отписывается от вотчера. */
  unwatch(): void {
    if (this.watcher) {
      const all = Array.isArray(this.watcher) ? this.watcher : [this.watcher];
      for (const w of all) {
        try {
          w.close();
        } catch {
          // Уже закрыт — нечего делать.
        }
      }
      this.watcher = null;
    }
  }

  /**
   * Обходит каждый индексируемый исходник под `baseDir` и зовёт `visit` с
   * полным путём, относительным путём, id языка и stat. Уважает `maxFiles`,
   * `IGNORE_DIRS` и `.gitignore`/`.mmaignore`; содержимое НЕ читает — `walk()`
   * читает его для извлечения символов, а `scanSignature()` пользуется только
   * stat. Общий, чтобы оба прохода видели ровно то же множество файлов.
   */
  private eachSourceFile(
    visit: (fullPath: string, relPath: string, language: string, stat: Stats) => void,
  ): void {
    this.walkDir(this.baseDir, visit, { count: 0 });
  }

  /** Рекурсивный обход каталога с общим счётчиком визитов. */
  private walkDir(
    dir: string,
    visit: (fullPath: string, relPath: string, language: string, stat: Stats) => void,
    state: { count: number },
  ): void {
    if (state.count >= this.maxFiles || !existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (state.count >= this.maxFiles) return;
      if (this.visitEntry(dir, entry, visit, state)) state.count++;
    }
  }

  /**
   * Обрабатывает одну запись каталога: рекурсия в подкаталог или `visit`
   * исходника. Возвращает true, если запись — проиндексированный файл.
   */
  private visitEntry(
    dir: string,
    entry: string,
    visit: (fullPath: string, relPath: string, language: string, stat: Stats) => void,
    state: { count: number },
  ): boolean {
    const fullPath = join(dir, entry);
    const relPath = relative(this.baseDir, fullPath);
    // Изоляция на запись: файл, удалённый (или нечитаемый) между readdir
    // и stat, не должен убивать весь обход. Симлинки пропускаем — могут
    // вести наружу или образовывать циклы каталогов.
    try {
      const lst = lstatSync(fullPath, { throwIfNoEntry: false });
      if (!lst || lst.isSymbolicLink()) return false;
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (!isIgnoredDirName(entry) && !this.ignores.ignores(relPath, true)) {
          this.walkDir(fullPath, visit, state);
        }
        return false;
      }
      if (!stat.isFile()) return false;
      if (isIgnoredFileName(entry) || this.ignores.ignores(relPath, false)) return false;
      const language = languageIdForExt(extname(entry).toLowerCase());
      if (!language) return false;
      visit(fullPath, relPath, language, stat);
      return true;
    } catch (e) {
      // Запись пропала или нечитаема — пропускаем, индексируем остальные.
      logger.warn(t("env.index_skip_unreadable", { path: relPath }), { error: String(e) });
      return false;
    }
  }

  /**
   * Полный обход: читает файлы, извлекает символы. Нечитаемые пропускает.
   *
   * Если передан предыдущий индекс, файлы с совпадающими `size` и `mtimeMs`
   * переиспользуются без чтения и повторного regex-разбора — тёплый пересбор
   * после правки одного файла стоит один обход `stat` + чтение изменённых.
   */
  async walk(prev?: IndexResult | null): Promise<IndexResult> {
    const files: IndexedFile[] = [];
    let totalSize = 0;

    const prevByPath = new Map<string, IndexedFile>();
    if (prev) {
      for (const f of prev.files) prevByPath.set(f.path.replace(/\\/g, "/"), f);
    }

    this.eachSourceFile((fullPath, relPath, language, stat) => {
      const key = relPath.replace(/\\/g, "/");
      const cached = prevByPath.get(key);
      if (
        cached &&
        cached.size === stat.size &&
        typeof cached.mtimeMs === "number" &&
        cached.mtimeMs === stat.mtimeMs
      ) {
        files.push({ ...cached, path: relPath });
        totalSize += stat.size;
        return;
      }
      try {
        const content = readFileSync(fullPath, "utf-8");
        const symbols = extractSymbolsDetailed(content, language);
        files.push({
          path: relPath,
          language,
          symbols,
          imports: extractImports(content),
          exports: symbols.map((s) => s.name),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
        totalSize += stat.size;
      } catch (e) {
        // Чтение упало после успешного stat — пропускаем файл, берём остальные.
        logger.warn(t("env.index_skip_unreadable", { path: relPath }), { error: String(e) });
      }
    });

    return { files, totalSize };
  }

  /**
   * Дешёвый бесконтентный отпечаток индексируемого дерева: отсортированные
   * `path\0size\0mtimeMs`, хешированные SHA-1. `IndexCache` хранит его и
   * пересчитывает на load, отбраковывая протухший `index-cache.json` (файл
   * добавлен/удалён/правлен после обхода — сигнатура меняется). Только stat,
   * без чтения файлов — куда дешевле полного обхода.
   */
  scanSignature(): string {
    const parts: string[] = [];
    this.eachSourceFile((_fullPath, relPath, _language, stat) => {
      parts.push(`${relPath}\u0000${stat.size}\u0000${Math.floor(stat.mtimeMs)}`);
    });
    parts.sort();
    return createHash("sha1").update(parts.join("\n")).digest("hex");
  }

  /** Однострочная сводка индекса (файлы, размер, языки). */
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
