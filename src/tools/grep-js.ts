/**
 * Zero-dependency JS-обход для `grep`, когда в PATH нет ни `rg`, ни `grep`
 * (типичный Windows). Не претендует на скорость ripgrep: уважает
 * `.gitignore`/`.mmaignore`, пропускает бинарные/крупные файлы, ограничен по
 * времени и числу файлов, завершается досрочно.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from "fs";
import { join, relative } from "path";
import { isIgnoredDirName, isIgnoredFileName } from "../modules/indexer/walker";
import { loadIgnoreMatcher, type IgnoreMatcher } from "../modules/indexer/gitignore";

/** Опции JS-поиска. */
export interface JsGrepOptions {
  include?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  timeBudgetMs?: number;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_TIME_BUDGET_MS = 8000;

/** Простой glob по basename/пути: `*`, `?`, `**`. Достаточно для include. */
export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\?/g, ".")
    .replace(/\u0000/g, ".*");
  return new RegExp(`(^|/)${esc}$`);
}

function loadMatcher(baseDir: string): IgnoreMatcher {
  return loadIgnoreMatcher(baseDir, (p) => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  });
}

function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Читает один файл и пушит совпавшие строки в `out`. */
function scanFile(full: string, re: RegExp, out: string[], maxBytes: number): void {
  let buf: Buffer;
  try {
    if (statSync(full).size > maxBytes) return;
    buf = readFileSync(full);
  } catch {
    return;
  }
  if (isProbablyBinary(buf)) return;
  const lines = buf.toString("utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) out.push(`${full}:${i + 1}:${lines[i]}`);
  }
}

/**
 * Ищет `pattern` (regex) в дереве `searchPath` без внешних бинарей.
 * @returns строки в формате `path:line:text` (как `rg -n --with-filename`).
 */
// fallow-ignore-next-line complexity
export function searchWithJs(
  pattern: string,
  searchPath: string,
  baseDir: string,
  opts: JsGrepOptions = {},
): string {
  const re = new RegExp(pattern);
  const includeRe = opts.include ? globToRegExp(String(opts.include)) : null;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const deadline = Date.now() + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const matcher = loadMatcher(baseDir);
  const out: string[] = [];
  let files = 0;
  let truncated = false;

  const shouldSkip = (entry: Dirent, rel: string): boolean => {
    if (isIgnoredFileName(entry.name)) return true;
    if (matcher.ignores(rel, false)) return true;
    if (includeRe && !includeRe.test(rel) && !includeRe.test(entry.name)) return true;
    return false;
  };

  const stack: string[] = [searchPath];
  while (stack.length > 0) {
    if (Date.now() > deadline || files >= maxFiles) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const full = join(dir, entry.name);
      const rel = relative(baseDir, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!isIgnoredDirName(entry.name) && !matcher.ignores(rel, true)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || shouldSkip(entry, rel)) continue;
      files++;
      if (files > maxFiles) {
        truncated = true;
        break;
      }
      scanFile(full, re, out, maxBytes);
    }
  }
  if (truncated) out.push(`... (search truncated at ${files} files / time budget)`);
  return out.join("\n");
}
