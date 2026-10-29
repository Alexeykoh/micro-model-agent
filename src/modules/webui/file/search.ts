// Ограниченный поиск по содержимому workspace для вкладки Files (C-01).
//
// Это НЕ индексатор: поиск не должен требовать тёплого индекса и не должен
// читать весь проект. Обход ограничен результатами, файлами, байтами и
// временем; при упоре в любой кап ответ помечается `truncated`.
//
// Игноры и защита — те же примитивы, что у дерева/индексатора:
// `IGNORE_DIRS`/`IGNORE_FILE_NAMES`, `.gitignore`/`.mmaignore`, скрытые globs
// политики данных, `matchProtectedPath`. Симлинки не разворачиваются.
import { readFileSync, type Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadIgnoreMatcher, type IgnoreMatcher } from "../../indexer/gitignore";
import { isIgnoredDirName, isIgnoredFileName } from "../../indexer/walker";
import { matchAnyGlob } from "../../security/data-policy/path-policy";
import { matchProtectedPath } from "../../security/protected-paths";
import { decodeText } from "./file-api";

/** Максимальная длина запроса (символов). */
export const MAX_SEARCH_QUERY = 200;
/** Максимум строк-совпадений в ответе. */
export const MAX_SEARCH_RESULTS = 50;
/** Максимум прочитанных файлов за один запрос. */
export const MAX_SEARCH_FILES = 5000;
/** Суммарный бюджет чтения за один запрос. */
export const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
/** Файлы больше этого не читаются (как у `/api/file`). */
export const MAX_SEARCH_FILE_BYTES = 512 * 1024;
/** Мягкий дедлайн обхода: дальше отвечаем тем, что успели. */
export const MAX_SEARCH_MS = 2500;
/** Предел текста одной совпавшей строки в ответе. */
export const MAX_MATCH_TEXT = 200;
/** Сгенерированные артефакты: в поиске по содержимому только шумят. */
const GENERATED_FILE_SUFFIXES = [".tsbuildinfo"];

/** Одно совпадение: путь, 1-based строка и её обрезанный текст. */
export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** Результат поиска: строки + признаки упора в кап. */
export interface SearchResult {
  results: SearchHit[];
  truncated: boolean;
  ms: number;
  scanned: number;
}

/** Внутренние капы; тесты могут сузить их, не раздувая workspace. */
export interface SearchOptions {
  maxResults?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxMs?: number;
}

interface WalkState {
  results: SearchHit[];
  scanned: number;
  bytes: number;
  truncated: boolean;
  deadline: number;
  needle: string;
  maxResults: number;
  maxFiles: number;
  maxBytes: number;
}

/** Читает файл игноров из корня; fail-open (null — правила не применяются). */
function readIgnoreFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Ищет `needle` (lowercase) по строкам уже декодированного текста. */
function collectHits(
  relPath: string,
  text: string,
  state: WalkState,
): void {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(state.needle)) continue;
    state.results.push({
      path: relPath,
      line: i + 1,
      text: lines[i].trim().slice(0, MAX_MATCH_TEXT),
    });
    if (state.results.length >= state.maxResults) {
      state.truncated = true;
      return;
    }
  }
}

/** True, если бюджет времени исчерпан. */
function outOfTime(state: WalkState): boolean {
  return Date.now() > state.deadline;
}

/** Прочитанный файл: пропускает бинарные и слишком большие, копит байты. */
async function scanFile(fullPath: string, relPath: string, state: WalkState): Promise<boolean> {
  const info = await stat(fullPath);
  if (!info.isFile() || info.size > MAX_SEARCH_FILE_BYTES) return true;
  if (state.bytes + info.size > state.maxBytes) {
    state.truncated = true;
    return false;
  }
  const buf = await readFile(fullPath);
  state.bytes += buf.length;
  state.scanned++;
  const { text, binary } = decodeText(buf);
  if (!binary) collectHits(relPath, text, state);
  return state.results.length < state.maxResults;
}

/** Обходит каталог; возвращает false, когда пора остановиться. */
async function walkDir(
  base: string,
  dirAbs: string,
  relDir: string,
  matcher: IgnoreMatcher,
  hiddenGlobs: readonly string[],
  state: WalkState,
): Promise<boolean> {
  if (outOfTime(state) || state.scanned >= state.maxFiles) {
    state.truncated = true;
    return false;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return true; // нечитаемый каталог — пропускаем, идём дальше
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (state.results.length >= state.maxResults || outOfTime(state)) {
      state.truncated = true;
      return false;
    }
    const fullPath = join(dirAbs, entry.name);
    const relChild = relDir ? `${relDir}/${entry.name}` : entry.name;
    // Симлинк/джанкшен может вести наружу или дать цикл — не идём.
    if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) continue;
    const isDir = entry.isDirectory();
    if (isDir ? isIgnoredDirName(entry.name) : isIgnoredFileName(entry.name)) continue;
    if (!isDir && GENERATED_FILE_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
    if (matcher.ignores(relChild, isDir)) continue;
    if (matchAnyGlob(relChild, hiddenGlobs)) continue;
    if (matchProtectedPath(base, fullPath)) continue;
    if (isDir) {
      if (!(await walkDir(base, fullPath, relChild, matcher, hiddenGlobs, state))) return false;
      continue;
    }
    if (state.scanned >= state.maxFiles) {
      state.truncated = true;
      return false;
    }
    try {
      if (!(await scanFile(fullPath, relChild, state))) return false;
    } catch {
      // Нечитаемый/исчезнувший файл не отменяет остальные.
    }
  }
  return true;
}

/** Нормализует сепараторы Windows в прямой слэш. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Ищет подстроку (без учёта регистра) по текстовым файлам workspace
 * `base`. `hiddenGlobs` — активные `security.dataPolicy.apiHiddenGlobs`.
 */
export async function searchWorkspace(
  base: string,
  query: string,
  hiddenGlobs: readonly string[] = [],
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const started = Date.now();
  const matcher = loadIgnoreMatcher(base, readIgnoreFile);
  const state: WalkState = {
    results: [],
    scanned: 0,
    bytes: 0,
    truncated: false,
    deadline: started + (opts.maxMs ?? MAX_SEARCH_MS),
    needle: query.toLowerCase(),
    maxResults: opts.maxResults ?? MAX_SEARCH_RESULTS,
    maxFiles: opts.maxFiles ?? MAX_SEARCH_FILES,
    maxBytes: opts.maxBytes ?? MAX_SEARCH_BYTES,
  };
  await walkDir(base, base, "", matcher, hiddenGlobs, state);
  const results = state.results.map((h) => ({ ...h, path: toPosix(h.path) }));
  return { results, truncated: state.truncated, ms: Date.now() - started, scanned: state.scanned };
}
