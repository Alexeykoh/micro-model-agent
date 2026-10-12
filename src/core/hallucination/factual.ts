// Фактическая проверка: упомянутые в ответе пути файлов против диска и индекса.
import { existsSync, readdirSync, type Dirent } from "fs";
import { resolve, isAbsolute, join } from "path";
import type { HallucinationCheckResult } from "./detector";
import { t } from "../../i18n/index";
import { extractFileLikeTokens, stripUrls } from "./js-identifiers";
import {
  HALLUCINATION_NAME_CACHE_TTL_MS,
  HALLUCINATION_RESCAN_COOLDOWN_MS,
} from "../../config/timeouts";

/** Генерированные/кэшированные каталоги — пропускаем при поиске голых имён. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".mma",
  "_testing",
]);

/** Проверка фактов: упомянутые файлы существуют на диске/в индексе, иначе warn. */
export class FactualCheck {
  private baseDir: string;
  private nameCache: Map<string, string[]> | null = null;
  private nameCacheTime = 0;
  private lastRescan = 0;
  private static readonly NAME_CACHE_TTL_MS = HALLUCINATION_NAME_CACHE_TTL_MS;
  private static readonly RESCAN_COOLDOWN_MS = HALLUCINATION_RESCAN_COOLDOWN_MS;
  private static readonly MAX_INDEXED_FILES = 20_000;
  /** Файлы, известные из сводок компакции — переживают сбросы контекста. */
  private knownFiles = new Set<string>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Добавляет пути, известные из сводок компакции. Проверяются раньше скана ФС:
   *  голые имена из уплотнённых ходов узнаются, даже если каталог в IGNORED_DIRS. */
  addKnownFiles(files: string[]): void {
    for (const f of files) this.knownFiles.add(f);
  }

  /**
   * Валидирует пути файлов в ответе: warn со списком отсутствующих, иначе pass.
   * @param response текст ответа модели; @param deletedFiles уже удалённые (не флагуются).
   */
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
   * Голые имена ("bikes.json") и относительные пути ("src/data/bikes.json")
   * садятся на дерево проекта. Абсолютные проверяются как есть.
   */
  private pathExists(fp: string): boolean {
    if (isAbsolute(fp)) return existsSync(fp);

    // Сначала известные файлы из сводок компакции
    if (this.knownFiles.has(fp)) return true;

    for (const cand of this.dotfileVariants(fp)) {
      if (this.knownFiles.has(cand)) return true;
      if (existsSync(resolve(this.baseDir, cand))) return true;
    }

    // "foo.json" без каталога — голое имя, которое может жить где угодно под
    // baseDir (напр. src/data/bikes.json). Резолв только от корня давал ложные
    // "unknown file".
    if (!fp.includes("/") && !fp.includes("\\")) {
      return this.bareNameExists(fp);
    }

    // Суффиксный матч (ses_mup6p61q): "webui/state.ts" — хвост реального пути
    // "src/modules/webui/state.ts". Резолв только от корня давал ложный warn
    // на существующие файлы. Новых обходов ФС нет — кандидаты берутся из
    // basename-индекса (уже ограничен и кэширован) и knownFiles.
    return this.suffixExists(fp);
  }

  private suffixExists(fp: string): boolean {
    const norm = fp.replace(/\\/g, "/");
    const tail = `/${norm}`;
    const base = norm.split("/").pop() ?? norm;
    const fwd = (p: string): string => p.replace(/\\/g, "/");
    for (const known of this.knownFiles) {
      if (fwd(known).endsWith(tail)) return true;
    }
    const checkIndex = (): boolean => {
      for (const full of this.getNameIndex().get(base) ?? []) {
        if (fwd(full).endsWith(tail)) return true;
      }
      return false;
    };
    if (checkIndex()) return true;
    // Файл сессии мог появиться после сборки индекса — разовый рескан
    // (rate-limited, общий с bareNameExists).
    const now = Date.now();
    if (now - this.lastRescan < FactualCheck.RESCAN_COOLDOWN_MS) return false;
    this.lastRescan = now;
    this.nameCache = null;
    this.nameCacheTime = 0;
    return checkIndex();
  }

  /**
   * Токен-regex не якорит ведущую точку (`\b` не матчится между не-словом и
   * `.`), поэтому дотфайлы (.prettierrc.json, .env, …) извлекаются как
   * "prettierrc.json". Перед вердиктом "нет файла" пробуем basename с точкой,
   * "src/config.json" даёт и "src/.config.json", а "mma/index-cache.json" —
   * и ".mma/index-cache.json" (родители с точкой).
   */
  private dotfileVariants(fp: string): string[] {
    const variants = [fp];
    const sep = fp.includes("\\") ? "\\" : "/";
    const parts = fp.split(sep);

    // Пробуем basename с точкой (старая логика)
    const base = parts[parts.length - 1];
    if (!base.startsWith(".")) {
      const withDotBase = [...parts.slice(0, -1), `.${base}`].join(sep);
      variants.push(withDotBase);
    }

    // Пробуем точку на каждом родительском компоненте
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
      // Известные файлы: голое имя может совпасть с полным путём из компакции
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

    // write_file текущей сессии мог создать файл после сборки индекса.
    // Перед warn — разовый рескан (rate-limited).
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
   * Индекс basename → пути, пересборка каждые NAME_CACHE_TTL_MS, чтобы новые
   * файлы (write_file) подхватывались без полного скана на каждый ответ.
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
