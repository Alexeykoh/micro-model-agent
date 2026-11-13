/**
 * Workspace-файлы для wire-панелей (split W4b): резолвер путей, скрытые globs
 * и листинг одной директории. Вынесено из `webui/file/*`, чтобы service и web
 * использовали один джейл и один список игноров.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AppConfig } from "../config/types";
import { matchProtectedPath } from "../modules/security/protected-paths";
import { hiddenReason, matchAnyGlob } from "../modules/security/data-policy/path-policy";
import { isIgnoredDirName, isIgnoredFileName } from "../modules/indexer/walker";
import { loadIgnoreMatcher } from "../modules/indexer/gitignore";

/** True, когда `target` вне `base` (лексически). */
export function escapes(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Класс отказа резолва пути. */
export type PathErrorCode = "outside_workspace" | "protected_path" | "not_found";

/** Результат резолва: реальный абсолютный путь либо класс отказа. */
export type PathResolution =
  { ok: true; absReal: string; baseReal: string } | { ok: false; code: PathErrorCode };

/** Узкий вход файловых роутов: workspace + живой конфиг. */
export interface PathPolicyStore {
  workspace?: string;
  config?: AppConfig;
}

/** Активный glob-список скрытых путей (пустой, если политика выключена). */
export function apiHiddenGlobs(config: AppConfig | undefined): string[] {
  const dp = config?.security?.dataPolicy;
  if (!dp || dp.enabled === false) return [];
  return dp.apiHiddenGlobs;
}

/** Резолвит `raw` (абсолютный или относительно `base`) в реальный путь внутри base. */
export async function resolveWorkspacePath(base: string, raw: string): Promise<PathResolution> {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  if (escapes(resolve(base), abs)) return { ok: false, code: "outside_workspace" };
  let baseReal: string;
  let absReal: string;
  try {
    baseReal = await realpath(resolve(base));
    absReal = await realpath(abs);
  } catch {
    return { ok: false, code: "not_found" };
  }
  if (escapes(baseReal, absReal)) return { ok: false, code: "outside_workspace" };
  if (matchProtectedPath(baseReal, absReal)) return { ok: false, code: "protected_path" };
  return { ok: true, absReal, baseReal };
}

/** Кап записей одной директории; при упоре дерево помечается `truncated`. */
export const MAX_DIR_ENTRIES = 1000;

/** Запись дерева: имя, тип и размер (у файлов). */
export interface FileEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
}

/** Листинг директории для панели Files. */
export interface DirListing {
  entries: FileEntry[];
  truncated: boolean;
}

/** Листит одну директорию `dirAbs`, фильтруя игноры и скрытые пути. */
export async function listDir(
  base: string,
  dirAbs: string,
  hiddenGlobs: readonly string[] = [],
): Promise<DirListing> {
  const matcher = loadIgnoreMatcher(base, (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  });
  const relDir = toPosix(relative(base, dirAbs)).replace(/^\.$/, "").replace(/^\/+/, "");
  const dirents = await readdir(dirAbs, { withFileTypes: true });
  const visible = dirents.filter((d) =>
    isVisibleEntry(d, dirAbs, relDir, base, matcher, hiddenGlobs),
  );
  const capped = visible.slice(0, MAX_DIR_ENTRIES);
  const entries = await Promise.all(capped.map((d) => toEntry(dirAbs, d.name, d.isDirectory())));
  sortEntries(entries);
  return { entries, truncated: visible.length > MAX_DIR_ENTRIES };
}

/** True, если запись не скрыта игнорами индексатора или protected-паттерном. */
function isVisibleEntry(
  d: { name: string; isDirectory(): boolean; isFile(): boolean },
  dirAbs: string,
  relDir: string,
  base: string,
  matcher: ReturnType<typeof loadIgnoreMatcher>,
  hiddenGlobs: readonly string[],
): boolean {
  const isDir = d.isDirectory();
  if (!isDir && !d.isFile()) return false;
  const relChild = relDir ? `${relDir}/${d.name}` : d.name;
  if (isDir ? isIgnoredDirName(d.name) : isIgnoredFileName(d.name)) return false;
  if (matcher.ignores(relChild, isDir)) return false;
  if (matchAnyGlob(relChild, hiddenGlobs)) return false;
  return !matchProtectedPath(base, join(dirAbs, d.name));
}

/** Строит запись дерева (с размером у файлов). */
async function toEntry(dirAbs: string, name: string, isDir: boolean): Promise<FileEntry> {
  if (isDir) return { name, type: "dir" };
  try {
    const size = (await stat(join(dirAbs, name))).size;
    return { name, type: "file", size };
  } catch {
    return { name, type: "file" };
  }
}

/** Папки сверху, затем файлы; регистронезависимо по алфавиту. */
function sortEntries(entries: FileEntry[]): void {
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Нормализует сепараторы Windows в прямой слэш. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export { hiddenReason };
